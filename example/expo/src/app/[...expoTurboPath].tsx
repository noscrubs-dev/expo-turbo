import { DemoRouteScreen } from "../demo-route-screen";

export function generateStaticParams() {
  return [
    { expoTurboPath: ["demo"] },
    { expoTurboPath: ["demo", "linked"] },
  ];
}

export default DemoRouteScreen;
