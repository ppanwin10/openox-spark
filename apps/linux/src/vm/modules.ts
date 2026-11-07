import { approvalsModule } from "./approvals";
import { browserModule } from "./browser/index";
import type { VMFactory } from "./context";
import { conversationsModule } from "./conversations";
import { modelsModule } from "./models";
import { schedulesModule } from "./schedules";
import { servicesModule } from "./services/index";
import { skillsModule } from "./skills";
import { webModule } from "./web";

export const factories: VMFactory[] = [approvalsModule, webModule, browserModule, servicesModule, skillsModule, schedulesModule, conversationsModule, modelsModule];
