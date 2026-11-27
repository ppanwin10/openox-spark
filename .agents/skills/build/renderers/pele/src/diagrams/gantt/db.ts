import { PeleError } from '../../errors.js';
import { safeUrl } from '../../util/url.js';
import { WEEKDAYS, add, addDays, format, isValid, isoDate, parseStrict, type Unit } from './dates.js';
import type { GanttModel, GanttTask } from './types.js';

export interface GanttDbOptions {
  warn?: (message: string) => void;
}

type Tag = 'active' | 'done' | 'crit' | 'milestone' | 'vert';

const RE_NUMERIC_FORMAT = /^[YMDHhmsSZXx\-/.:, T]*$/;
const RE_TAG = /^\s*(active|done|crit|milestone|vert)\s*$/;
const RE_AFTER = /^after\s+([\d\w- ]+)$/;
const RE_UNTIL = /^until\s+([\d\w- ]+)$/;
const RE_DURATION = /^(\d+(?:\.\d+)?)([Mdhmswy]|ms)$/;
const RE_TOKEN_SPLIT = /[\s,]+/;
const RE_DIGITS = /^\d+$/;
const DAY_NAMES = new Set(WEEKDAYS.map((day) => day.toLowerCase()));
const WORK_LIMIT = 4e8;
const DAY_STEP = 400;
const DATED_STEP = 200;
const FORMAT_STEP = 400;

export function clock(now?: number | Date): number {
  const given = now === undefined ? NaN : +now;
  return Number.isFinite(given) ? given : Date.now();
}

export function parseDuration(str: string): [number, Unit] {
  const statement = RE_DURATION.exec(str.trim());
  return statement ? [Number.parseFloat(statement[1]), statement[2] as Unit] : [NaN, 'ms'];
}

function mergeTokens(existing: string[], txt: string): string[] {
  const merged = new Set(existing);
  for (const token of txt.toLowerCase().split(RE_TOKEN_SPLIT)) if (token !== '') merged.add(token);
  return [...merged];
}

export class GanttDb implements GanttModel {
  readonly type = 'gantt' as const;
  title: string | undefined;
  accTitle: string | undefined;
  accDescr: string | undefined;
  dateFormat = '';
  axisFormat = '';
  tickInterval: string | undefined;
  todayMarker = '';
  includes: string[] = [];
  excludes: string[] = [];
  inclusiveEndDates = false;
  topAxis = false;
  displayMode = '';
  weekday: string | undefined;
  weekend = 'saturday';
  sections: string[] = [];
  links = new Map<string, string>();
  tasks: GanttTask[] = [];

  private byId = new Map<string, GanttTask>();
  private currentSection = '';
  private taskCount = 0;
  private lastOrder = 0;
  private lastTaskId: string | undefined;
  private now = 0;
  private work = 0;
  private includeSet = new Set<string>();
  private excludeSet = new Set<string>();
  private excludedDays: boolean[] = [];
  private datedTokens = false;

  constructor(_options: GanttDbOptions = {}) {}

  setDateFormat(txt: string): void {
    this.dateFormat = txt;
  }

  enableInclusiveEndDates(): void {
    this.inclusiveEndDates = true;
  }

  TopAxis(): void {
    this.topAxis = true;
  }

  setAxisFormat(txt: string): void {
    this.axisFormat = txt;
  }

  setTickInterval(txt: string): void {
    this.tickInterval = txt;
  }

  setTodayMarker(txt: string): void {
    this.todayMarker = txt;
  }

  setIncludes(txt: string): void {
    this.includes = mergeTokens(this.includes, txt);
  }

  setExcludes(txt: string): void {
    this.excludes = mergeTokens(this.excludes, txt);
  }

  setWeekday(txt: string): void {
    this.weekday = txt;
  }

  setWeekend(startDay: string): void {
    this.weekend = startDay;
  }

  setDiagramTitle(txt: string): void {
    this.title = txt;
  }

  setAccTitle(txt: string): void {
    this.accTitle = txt.replace(/^\s+/g, '');
  }

  setAccDescription(txt: string): void {
    this.accDescr = txt.replace(/\n\s+/g, '\n');
  }

  addSection(txt: string): void {
    this.currentSection = txt;
    this.sections.push(txt);
  }

  addTask(descr: string, dataStr: string): void {
    const data = (dataStr.startsWith(':') ? dataStr.slice(1) : dataStr).split(',');
    const task: GanttTask = {
      id: '',
      task: descr,
      section: this.currentSection,
      startTime: undefined,
      endTime: undefined,
      renderEndTime: null,
      manualEndTime: false,
      processed: false,
      active: false,
      done: false,
      crit: false,
      milestone: false,
      vert: false,
      order: -1,
      classes: [],
      prevTaskId: this.lastTaskId,
      raw: { data: dataStr, start: undefined, end: '' },
    };

    let tag: RegExpExecArray | null;
    while (data.length > 0 && (tag = RE_TAG.exec(data[0])) !== null) {
      task[tag[1] as Tag] = true;
      data.shift();
    }
    if (data.length === 0) {
      throw new PeleError(`Task "${descr.trim()}" needs a duration or an end date.`, 'semantic', { type: 'gantt' });
    }
    if (data.length > 3) {
      throw new PeleError(
        `Task "${descr.trim()}" has too many fields. A task takes an id, a start, and an end or duration.`,
        'semantic',
        { type: 'gantt' }
      );
    }
    for (let i = 0; i < data.length; i++) data[i] = data[i].trim();

    if (data.length === 3) {
      task.id = data[0];
    } else {
      this.taskCount++;
      task.id = 'task' + this.taskCount;
    }
    if (data.length > 1) task.raw.start = data[data.length - 2];
    task.raw.end = data[data.length - 1];

    if (!task.vert) task.order = this.lastOrder++;
    this.tasks.push(task);
    this.lastTaskId = task.id;
    this.byId.set(task.id, task);
  }

  setLink(ids: string, link: string): void {
    const href = safeUrl(link);
    for (const id of ids.split(',')) {
      if (this.byId.has(id)) this.links.set(id, href);
    }
    this.setClass(ids, 'clickable');
  }

  setClickEvent(ids: string, _functionName: string, _functionArgs: string | null): void {
    this.setClass(ids, 'clickable');
  }

  setClass(ids: string, className: string): void {
    for (const id of ids.split(',')) this.byId.get(id)?.classes.push(className);
  }

  getTasks(now?: number | Date): GanttTask[] {
    this.now = clock(now);
    this.work = 0;
    this.includeSet = new Set(this.includes);
    this.excludeSet = new Set(this.excludes);
    const weekendStart = this.weekend === 'friday' ? 5 : this.weekend === 'saturday' ? 6 : NaN;
    const weekends = this.excludeSet.has('weekends');
    this.excludedDays = WEEKDAYS.map((name, day) => {
      const iso = day || 7;
      return (weekends && (iso === weekendStart || iso === weekendStart + 1)) || this.excludeSet.has(name.toLowerCase());
    });
    this.datedTokens = this.includes.length > 0 || !RE_NUMERIC_FORMAT.test(this.dateFormat.trim());
    for (const token of this.excludes) if (token !== 'weekends' && !DAY_NAMES.has(token)) this.datedTokens = true;

    for (const task of this.tasks) {
      task.startTime = task.endTime = undefined;
      task.renderEndTime = null;
      task.processed = task.manualEndTime = false;
    }

    let allProcessed = this.compileTasks();
    for (let i = 0; !allProcessed && i < 10; i++) allProcessed = this.compileTasks();
    if (!allProcessed) throw new PeleError('Gantt dependencies could not be resolved.', 'semantic', { type: 'gantt' });
    return this.tasks;
  }

  isInvalidDate(date: Date): boolean {
    const weekday = this.excludedDays[date.getDay()];
    if (!this.datedTokens) return weekday;
    const template = this.dateFormat.trim();
    const dateOnly = isoDate(date);
    let formatted: string | undefined = dateOnly;
    this.spend(DATED_STEP);
    if (template !== 'YYYY-MM-DD') {
      this.spend(FORMAT_STEP + template.length * 8);
      formatted = format(date, template);
    }
    const listed = (set: Set<string>): boolean => set.has(dateOnly) || (formatted !== undefined && set.has(formatted));
    if (listed(this.includeSet)) return false;
    return weekday || listed(this.excludeSet);
  }

  private spend(units: number): void {
    this.work += units;
    if (this.work > WORK_LIMIT) {
      throw new PeleError('The gantt chart takes too much work to schedule.', 'limit', { type: 'gantt' });
    }
  }

  private parse(str: string, template: string): Date | undefined {
    this.spend((template.length + 1) * (str.length + 1));
    return parseStrict(str, template, new Date(this.now));
  }

  private compileTasks(): boolean {
    let allProcessed = true;
    for (const task of this.tasks) {
      this.compileTask(task);
      allProcessed = allProcessed && task.processed;
    }
    return allProcessed;
  }

  private compileTask(task: GanttTask): void {
    const start = task.raw.start;
    if (start === undefined) {
      const previous = task.prevTaskId === undefined ? undefined : this.byId.get(task.prevTaskId);
      if (!previous) throw new PeleError('The first Gantt task needs a start date.', 'semantic', { type: 'gantt' });
      task.startTime = previous.endTime;
    } else {
      const startTime = this.getStartDate(start);
      if (startTime) task.startTime = startTime;
    }
    if (!task.startTime) return;
    task.endTime = this.getEndDate(task.startTime, task.raw.end);
    if (!task.endTime) return;
    if (task.endTime < task.startTime) throw new PeleError('A Gantt task ends before it starts.', 'semantic', { type: 'gantt' });
    task.processed = true;
    task.manualEndTime = this.parse(task.raw.end, 'YYYY-MM-DD') !== undefined;
    this.checkTaskDates(task);
  }

  private references(keyword: 'after' | 'until', list: string): GanttTask[] {
    const found: GanttTask[] = [];
    for (const id of list.split(' ')) {
      if (id === '') continue;
      const task = this.byId.get(id);
      if (!task) throw new PeleError(`Unknown Gantt ${keyword} dependency: ${id}`, 'semantic', { type: 'gantt' });
      found.push(task);
    }
    if (!found.length) throw new PeleError(`A Gantt ${keyword} dependency needs a task.`, 'semantic', { type: 'gantt' });
    return found;
  }

  private getStartDate(raw: string): Date | undefined {
    const str = raw.trim();
    const template = this.dateFormat.trim() || 'YYYY-MM-DD';

    if ((template === 'x' || template === 'X') && RE_DIGITS.test(str))
      return this.checked(new Date(Number(str) * (template === 'X' ? 1000 : 1)), str);

    const after = RE_AFTER.exec(str);
    if (after !== null) {
      const tasks = this.references('after', after[1]);
      if (tasks.some(task => !task.endTime)) return undefined;
      let latest = tasks[0];
      for (const task of tasks) if (task.endTime! > latest.endTime!) latest = task;
      return latest.endTime;
    }

    const parsed = this.parse(str, template);
    if (parsed) return parsed;
    throw new PeleError('Invalid date:' + str, 'semantic', { type: 'gantt' });
  }

  private checked(date: Date, str: string): Date {
    if (!isValid(date) || date.getFullYear() < -10000 || date.getFullYear() > 10000)
      throw new PeleError('Invalid date:' + str, 'semantic', { type: 'gantt' });
    return date;
  }

  private getEndDate(startTime: Date, raw: string): Date | undefined {
    const str = raw.trim();
    const until = RE_UNTIL.exec(str);
    if (until !== null) {
      const tasks = this.references('until', until[1]);
      if (tasks.some(task => !task.startTime)) return undefined;
      let earliest = tasks[0];
      for (const task of tasks) if (task.startTime! < earliest.startTime!) earliest = task;
      return earliest.startTime;
    }

    const template = this.dateFormat.trim() || 'YYYY-MM-DD';
    const parsed = this.parse(str, template);
    if (parsed) return this.checked(this.inclusiveEndDates ? addDays(parsed, 1) : parsed, str);

    const [value, unit] = parseDuration(str);
    if (!Number.isFinite(value)) throw new PeleError('Invalid Gantt duration or end date:' + str, 'semantic', { type: 'gantt' });
    return this.checked(add(startTime, value, unit), str);
  }

  private checkTaskDates(task: GanttTask): void {
    if (this.excludes.length === 0 || task.manualEndTime) return;
    const cursor = addDays(task.startTime!, 1);
    const endTime = new Date(task.endTime!);
    const maxEndTime = +addDays(endTime, 10000);
    let invalid = false;
    let renderEndTime: number | null = null;
    while (+cursor <= +endTime) {
      this.spend(DAY_STEP);
      if (!invalid) renderEndTime = +endTime;
      invalid = this.isInvalidDate(cursor);
      if (invalid) {
        endTime.setDate(endTime.getDate() + 1);
        if (+endTime > maxEndTime) {
          throw new PeleError(
            'Failed to find a valid date that was not excluded by `excludes` after 10,000 iterations.',
            'semantic',
            { type: 'gantt' }
          );
        }
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    task.endTime = endTime;
    task.renderEndTime = renderEndTime === null ? null : new Date(renderEndTime);
  }
}
