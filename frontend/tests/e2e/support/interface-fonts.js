const INTERFACE_FONT_PROBES = [
  { descriptor: '400 12px "Caffold D2 Coding"', text: "Caffold interface" },
  { descriptor: '700 12px "Caffold D2 Coding"', text: "Caffold interface" },
];

export async function waitForInterfaceFonts(page) {
  const unavailable = await page.evaluate(async (probes) => {
    const loaded = await Promise.all(
      probes.map(async ({ descriptor, text }) => {
        try {
          return (await document.fonts.load(descriptor, text)).length > 0;
        } catch {
          return false;
        }
      }),
    );
    await document.fonts.ready;
    return probes
      .filter(
        ({ descriptor, text }, index) =>
          !loaded[index] || !document.fonts.check(descriptor, text),
      )
      .map(({ descriptor }) => descriptor);
  }, INTERFACE_FONT_PROBES);

  if (unavailable.length > 0) {
    throw new Error(
      `Caffold interface fonts were unavailable: ${unavailable.join(", ")}`,
    );
  }
}
