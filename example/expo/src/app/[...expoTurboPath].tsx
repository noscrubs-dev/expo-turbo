import Head from "expo-router/head";

import { DemoRouteScreen } from "../demo-route-screen";

export function generateStaticParams() {
  return [
    { expoTurboPath: ["demo"] },
    { expoTurboPath: ["demo", "linked"] },
    { expoTurboPath: ["demo", "routes", "ios-proof", "details"] },
  ];
}

export default function ExpoTurboRoute() {
  return (
    <>
      <Head>
        <title>Expo Turbo compatibility gallery</title>
      </Head>
      <DemoRouteScreen />
    </>
  );
}
