import { DemoRouteScreen } from "../demo-route-screen";

export function generateStaticParams() {
  return [
    { expoTurboPath: ["demo"] },
    { expoTurboPath: ["demo", "linked"] },
    { expoTurboPath: ["demo", "routes", "ios-proof", "details"] },
  ];
}

export default DemoRouteScreen;
