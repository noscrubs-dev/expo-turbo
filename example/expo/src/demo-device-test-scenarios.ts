export const DEMO_DEVICE_TEST_SCENARIOS = Object.freeze({
  static: `<Gallery data-turbo-root="/demo">
    <DemoCard id="static-renderer" title="Rendered from XML" style-tokens="tone:info space:comfortable surface:elevated">
      <DemoText>This native card was admitted by Zod and rendered through expo-turbo/react.</DemoText>
    </DemoCard>
    <DemoCard id="direction-card" dir="rtl" title="Native direction inheritance" style-tokens="tone:info space:compact">
      <DemoText>This text and card inherit the XML right-to-left direction.</DemoText>
      <DemoCard id="direction-ltr" dir="ltr" title="Explicit LTR override" style-tokens="space:compact">
        <DemoText>This nested card explicitly restores left-to-right direction.</DemoText>
      </DemoCard>
      <DemoCard id="direction-auto" dir="auto" title="Host-native automatic direction" style-tokens="space:compact">
        <DemoText>This text asks the native host to choose its writing direction.</DemoText>
      </DemoCard>
    </DemoCard>
    <DemoAction message="Hello from validated XML" />
  </Gallery>`,
  form: `<Gallery data-turbo-root="/demo">
    <DemoCard id="device-test-native-form" title="Live native form controls" style-tokens="tone:info space:compact">
      <DemoForm id="native-form" action="/demo/profile" dir="rtl" method="post">
        <DemoFormSubmitter id="collect-form" data-turbo-confirm="Send this immutable preview?" data-turbo-submits-with="Submitting preview…" formaction="/demo/profile/preview" formmethod="get" label="Confirm and submit immutable request" name="commit" value="preview" />
        <DemoFormInput id="first-name" autofocus="" dir="auto" dirname="profile[first_name].dir" label="First name" name="profile[first_name]" required="" value="Ada" />
        <DemoFormInput id="city" label="City" name="profile[city]" value="London" />
        <DemoFormFieldset id="disabled-profile-group" disabled="false">
          <DemoFormLegend>
            <DemoText>The first semantic legend remains enabled even when its fieldset is disabled.</DemoText>
            <DemoFormInput id="legend-note" label="Legend note" name="profile[legend_note]" value="Still included" />
          </DemoFormLegend>
          <DemoFormInput id="disabled-note" label="Disabled fieldset note" name="profile[disabled_note]" value="Omitted" />
        </DemoFormFieldset>
      </DemoForm>
    </DemoCard>
  </Gallery>`,
  "document-links-primary": `<Gallery data-turbo-root="/demo">
    <DemoDocumentLink href="/demo/linked?source=gallery&amp;tag=a&amp;tag=b&amp;empty="><DemoText>Open query document</DemoText></DemoDocumentLink>
    <DemoDocumentLink href="/demo/linked?preview=automatic" data-turbo-preload=""><DemoText>Open preloaded document</DemoText></DemoDocumentLink>
    <DemoDocumentLink href="/demo/linked?prefetch=reuse"><DemoText>Reuse press-in response</DemoText></DemoDocumentLink>
    <DemoDocumentLink href="/demo/linked?refresh=scroll"><DemoText>Open Refresh Stream document</DemoText></DemoDocumentLink>
    <DemoDocumentLink href="/demo/linked?replace=morph"><DemoText>Open replace morph document</DemoText></DemoDocumentLink>
    <DemoDocumentLink href="/demo/linked?autofocus=scroll"><DemoText>Open autofocus document</DemoText></DemoDocumentLink>
  </Gallery>`,
  "link-query": `<Gallery data-turbo-root="/demo"><DemoDocumentLink href="/demo/linked?source=gallery&amp;tag=a&amp;tag=b&amp;empty="><DemoText>Open query document</DemoText></DemoDocumentLink></Gallery>`,
  "link-preload": `<Gallery data-turbo-root="/demo"><DemoDocumentLink href="/demo/linked?preview=automatic" data-turbo-preload=""><DemoText>Open preloaded document</DemoText></DemoDocumentLink></Gallery>`,
  "link-prefetch": `<Gallery data-turbo-root="/demo"><DemoDocumentLink href="/demo/linked?prefetch=reuse"><DemoText>Reuse press-in response</DemoText></DemoDocumentLink></Gallery>`,
  "link-refresh": `<Gallery data-turbo-root="/demo"><DemoDocumentLink href="/demo/linked?refresh=scroll"><DemoText>Open Refresh Stream document</DemoText></DemoDocumentLink></Gallery>`,
  "link-replace-morph": `<Gallery data-turbo-root="/demo"><DemoDocumentLink href="/demo/linked?replace=morph"><DemoText>Open replace morph document</DemoText></DemoDocumentLink></Gallery>`,
  "link-autofocus": `<Gallery data-turbo-root="/demo"><DemoDocumentLink href="/demo/linked?autofocus=scroll"><DemoText>Open autofocus document</DemoText></DemoDocumentLink></Gallery>`,
  "document-links-secondary": `<Gallery data-turbo-root="/demo">
    <DemoDocumentLink href="/demo/routes/routing-proof/details?source=gallery&amp;tag=a&amp;tag=b&amp;empty="><DemoText>Open nested Router document</DemoText></DemoDocumentLink>
    <DemoDocumentLink href="#native-anchor-target"><DemoText>Jump to root anchor</DemoText></DemoDocumentLink>
    <DemoDocumentLink href="/demo/linked" data-turbo-action="replace"><DemoText>Replace Router entry</DemoText></DemoDocumentLink>
    <DemoDocumentLink href="/demo/generated-link?source=gallery" data-turbo-method="post" data-turbo-confirm="Submit this generated form link?"><DemoText>Submit generated link</DemoText></DemoDocumentLink>
    <DemoDocumentLink href="https://example.com"><DemoText>Open external link</DemoText></DemoDocumentLink>
    <DemoDocumentLink disabled="" href="/demo/disabled"><DemoText>Disabled native link</DemoText></DemoDocumentLink>
    <DemoCard title="Root anchor spacer" style-tokens="space:comfortable"><DemoText>Anchor spacer</DemoText></DemoCard>
    <DemoAnchorTarget id="native-anchor-target"><DemoCard title="Native anchor target" tone="positive"><DemoText>Root anchor reached</DemoText></DemoCard></DemoAnchorTarget>
  </Gallery>`,
  "link-router": `<Gallery data-turbo-root="/demo"><DemoDocumentLink href="/demo/routes/routing-proof/details?source=gallery&amp;tag=a&amp;tag=b&amp;empty="><DemoText>Open nested Router document</DemoText></DemoDocumentLink></Gallery>`,
  "link-anchor": `<Gallery data-turbo-root="/demo">
    <DemoDocumentLink href="#native-anchor-target"><DemoText>Jump to root anchor</DemoText></DemoDocumentLink>
    <DemoCard title="Root anchor spacer"><DemoText>Spacer</DemoText></DemoCard>
    <DemoAnchorTarget id="native-anchor-target"><DemoCard title="Native anchor target" tone="positive"><DemoText>Root anchor reached</DemoText></DemoCard></DemoAnchorTarget>
  </Gallery>`,
  "link-replace": `<Gallery data-turbo-root="/demo"><DemoDocumentLink href="/demo/linked" data-turbo-action="replace"><DemoText>Replace Router entry</DemoText></DemoDocumentLink></Gallery>`,
  "link-generated": `<Gallery data-turbo-root="/demo"><DemoDocumentLink href="/demo/generated-link?source=gallery" data-turbo-method="post" data-turbo-confirm="Submit this generated form link?"><DemoText>Submit generated link</DemoText></DemoDocumentLink></Gallery>`,
  "link-external-disabled": `<Gallery data-turbo-root="/demo">
    <DemoDocumentLink disabled="" href="/demo/disabled"><DemoText>Disabled native link</DemoText></DemoDocumentLink>
    <DemoDocumentLink href="https://example.com"><DemoText>Open external link</DemoText></DemoDocumentLink>
  </Gallery>`,
  frames: `<Gallery data-turbo-root="/demo">
    <DemoCard id="frame-promotion-device-proof" title="Frame promotion device proof"><DemoText>This compact scenario keeps the production Frame and generated-form controllers mounted.</DemoText></DemoCard>
    <turbo-frame id="link-frame">
      <DemoCard title="Frame-scoped native link">
        <DemoDocumentLink id="device-test-frame-promote" href="/demo/frame-form" data-turbo-method="post" data-turbo-action="advance"><DemoText>Promote generated Frame form</DemoText></DemoDocumentLink>
        <DemoDocumentLink id="device-test-frame-ordinary" href="/demo/frame-linked"><DemoText>Load ordinary Frame</DemoText></DemoDocumentLink>
        <DemoDocumentLink href="#frame-native-anchor-target"><DemoText>Jump within Frame</DemoText></DemoDocumentLink>
        <DemoDocumentLink data-turbo-preload="" href="/demo/frame-linked?preview=automatic#frame-linked-fragment-target"><DemoText>Use preloaded Frame fragment</DemoText></DemoDocumentLink>
        <DemoCard title="Frame anchor spacer"><DemoText>Spacer</DemoText></DemoCard>
        <DemoAnchorTarget id="frame-native-anchor-target"><DemoCard title="Frame native anchor target" tone="positive"><DemoText>Frame anchor reached</DemoText></DemoCard></DemoAnchorTarget>
      </DemoCard>
    </turbo-frame>
    <DemoDocumentLink href="#frame-native-anchor-target" data-turbo-frame="link-frame"><DemoText>Jump into named Frame anchor</DemoText></DemoDocumentLink>
  </Gallery>`,
  "frame-ordinary": `<Gallery data-turbo-root="/demo"><turbo-frame id="link-frame"><DemoDocumentLink href="/demo/frame-linked"><DemoText>Load ordinary Frame</DemoText></DemoDocumentLink></turbo-frame></Gallery>`,
  "frame-promote": `<Gallery data-turbo-root="/demo">
    <DemoCard id="frame-promotion-device-proof" title="Frame promotion device proof"><DemoText>This isolated scenario keeps the production Frame and generated-form controllers mounted.</DemoText></DemoCard>
    <turbo-frame id="link-frame"><DemoDocumentLink id="device-test-frame-promote" accessibility-label="Promote generated Frame form" href="/demo/frame-form" data-turbo-method="post" data-turbo-action="advance"><DemoText>Promote generated Frame form</DemoText></DemoDocumentLink></turbo-frame>
  </Gallery>`,
  "frame-anchor": `<Gallery data-turbo-root="/demo"><turbo-frame id="link-frame">
    <DemoDocumentLink href="#frame-native-anchor-target"><DemoText>Jump within Frame</DemoText></DemoDocumentLink>
    <DemoCard title="Frame anchor spacer"><DemoText>Spacer</DemoText></DemoCard>
    <DemoAnchorTarget id="frame-native-anchor-target"><DemoCard title="Frame native anchor target" tone="positive"><DemoText>Frame anchor reached</DemoText></DemoCard></DemoAnchorTarget>
  </turbo-frame></Gallery>`,
  "frame-preload": `<Gallery data-turbo-root="/demo"><turbo-frame id="link-frame"><DemoDocumentLink data-turbo-preload="" href="/demo/frame-linked?preview=automatic#frame-linked-fragment-target"><DemoText>Use preloaded Frame fragment</DemoText></DemoDocumentLink></turbo-frame></Gallery>`,
  "visibility-nested": `<Gallery data-turbo-root="/demo">
    <DemoCard id="nested-visibility-card" title="Nested lazy Frame visibility">
      <DemoScrollRegion id="nested-scroll-region">
        <DemoDocumentLink href="#nested-native-anchor-target"><DemoText>Jump within nested ScrollView</DemoText></DemoDocumentLink>
        <DemoCard title="Nested spacer"><DemoText>Spacer keeps Frame offscreen.</DemoText></DemoCard>
        <turbo-frame id="nested-lazy-frame" loading="lazy" src="/demo/nested-frame"><DemoCard title="Nested Frame placeholder"><DemoText>Nested lazy placeholder</DemoText></DemoCard></turbo-frame>
        <DemoAnchorTarget id="nested-native-anchor-target"><DemoCard title="Nested native anchor target" tone="positive"><DemoText>Nested anchor reached</DemoText></DemoCard></DemoAnchorTarget>
      </DemoScrollRegion>
    </DemoCard>
  </Gallery>`,
  "visibility-flatlist": `<Gallery data-turbo-root="/demo">
    <DemoCard id="flatlist-visibility-card" title="Virtualized lazy Frame visibility">
      <DemoFlatListRegion id="flatlist-frame-gallery" frame-ids='["flatlist-lazy-frame-one","flatlist-lazy-frame-two","flatlist-lazy-frame-three"]'><turbo-frame id="flatlist-lazy-frame-one" loading="lazy" src="/demo/flatlist/one"><DemoCard title="Virtualized Frame one"><DemoText>Frame one placeholder</DemoText></DemoCard></turbo-frame><turbo-frame id="flatlist-lazy-frame-two" loading="lazy" src="/demo/flatlist/two"><DemoCard title="Virtualized Frame two"><DemoText>Frame two placeholder</DemoText></DemoCard></turbo-frame><turbo-frame id="flatlist-lazy-frame-three" loading="lazy" src="/demo/flatlist/three"><DemoCard title="Virtualized Frame three"><DemoText>Frame three placeholder</DemoText></DemoCard></turbo-frame></DemoFlatListRegion>
    </DemoCard>
  </Gallery>`,
  "visibility-preview": `<Gallery data-turbo-root="/demo">
    <turbo-frame id="preview-frame" src="/demo/frame" loading="lazy" autoscroll="" data-autoscroll-block="start" data-autoscroll-behavior="smooth">
      <DemoCard title="Frame boundary"><DemoText>Preview lazy placeholder</DemoText></DemoCard>
    </turbo-frame>
  </Gallery>`,
  "root-controls": `<Gallery data-turbo-root="/demo">
    <DemoCard id="device-test-root-controls" title="Root controls device proof"><DemoText>Use the unchanged gallery controls below.</DemoText></DemoCard>
    <turbo-frame id="preview-frame"><DemoCard title="Programmatic Frame placeholder"><DemoText>Waiting for programmatic Frame visit.</DemoText></DemoCard></turbo-frame>
  </Gallery>`,
  history: `<Gallery data-turbo-root="/demo">
    <DemoCard title="History spacer one"><DemoText>Spacer</DemoText></DemoCard>
    <DemoCard title="History spacer two"><DemoText>Spacer</DemoText></DemoCard>
    <DemoCard id="history-scroll-marker" title="Native history scroll checkpoint" tone="positive">
      <DemoText>Return here from cached native history.</DemoText>
      <DemoDocumentLink href="/demo/linked?history=scroll"><DemoText>Open history restoration document</DemoText></DemoDocumentLink>
    </DemoCard>
  </Gallery>`,
} as const);

export type DemoDeviceTestScenario = keyof typeof DEMO_DEVICE_TEST_SCENARIOS;

export function demoDeviceTestScenario(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  return value in DEMO_DEVICE_TEST_SCENARIOS
    ? DEMO_DEVICE_TEST_SCENARIOS[value as DemoDeviceTestScenario]
    : undefined;
}
