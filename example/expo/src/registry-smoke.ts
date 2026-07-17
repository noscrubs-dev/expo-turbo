import {
  createRegistry,
  defineComponent,
  defineComponentModule,
  stringCodec,
} from "expo-turbo/registry";
import { z } from "zod";

const card = defineComponent({
  attributes: { title: { codec: stringCodec, prop: "title" } },
  children: "nodes",
  component: (props) => props.title,
  schema: z.object({ title: z.string() }),
  tag: "DemoCard",
});

const module = defineComponentModule({
  components: [card],
  name: "demo-primitives",
  version: "0.1.0",
});

export const REGISTRY_CAPABILITY_SMOKE = createRegistry(module).capabilities.hash;
