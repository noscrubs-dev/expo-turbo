import {
  createComponentActionRegistry,
  createComponentActionRunner,
  defineComponentAction,
  defineComponentActionModule,
} from "expo-turbo/registry";
import { DocumentStateStore } from "expo-turbo/core";
import { z } from "zod";

export const recordGreeting = defineComponentAction({
  action: "record-greeting",
  handler: ({ params, state }) => {
    state.set("last-greeting", params.message);
    return `Recorded: ${params.message}`;
  },
  schema: z.object({ message: z.string().min(1) }),
});

const actions = createComponentActionRegistry(
  defineComponentActionModule({
    actions: [recordGreeting],
    name: "demo-actions",
    version: "0.1.0",
  }),
);

export function createDemoActionRuntime() {
  const state = new DocumentStateStore();
  return Object.freeze({ actions: createComponentActionRunner(actions, state), state });
}
