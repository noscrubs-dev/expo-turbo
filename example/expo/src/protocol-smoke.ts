import { parseExpoTurboDocument, querySelectorAll } from "expo-turbo/core";

const tree = parseExpoTurboDocument(
  '<Gallery><DemoCard id="probe" class="selected" /></Gallery>',
);

export const PROTOCOL_SMOKE = `${tree.document.children.length}/${querySelectorAll(tree, ".selected").length}`;
