import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";

const exampleRoot = resolve(import.meta.dirname, "..");
const packageRoot = resolve(exampleRoot, "../..");
const hostReact = resolve(exampleRoot, "node_modules/react");
const packageReact = resolve(packageRoot, "node_modules/react");

if (!existsSync(hostReact)) {
  throw new Error("Install the Expo example dependencies before linking the React peer");
}

mkdirSync(dirname(packageReact), { recursive: true });

let packageReactExists = false;
try {
  lstatSync(packageReact);
  packageReactExists = true;
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

if (packageReactExists) {
  if (realpathSync(packageReact) === realpathSync(hostReact)) process.exit(0);
  throw new Error(
    "The Expo Turbo source checkout already resolves a different React installation",
  );
}

const target =
  process.platform === "win32"
    ? hostReact
    : relative(dirname(packageReact), hostReact);
symlinkSync(target, packageReact, process.platform === "win32" ? "junction" : "dir");
