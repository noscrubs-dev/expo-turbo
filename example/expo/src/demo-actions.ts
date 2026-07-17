import {
  createComponentActionRegistry,
  createComponentActionRunner,
  defineComponentAction,
  defineComponentActionModule,
  type ComponentActionStateStore,
} from "expo-turbo/registry";
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

export function createDemoActionRunner() {
  const values = new Map<string, unknown>();
  const state: ComponentActionStateStore = {
    delete: (key) => {
      values.delete(key);
    },
    get: (key) => values.get(key),
    set: (key, value) => {
      values.set(key, value);
    },
  };
  return createComponentActionRunner(actions, state);
}
