const SEGMENT_COUNT = 16;
const MINIMUM_SCALE = 0.18;

class CaffoldVoiceLevelMeter extends HTMLElement {
  connectedCallback() {
    if (!this.initialized) {
      this.initialized = true;
      this.levels = Array(SEGMENT_COUNT).fill(0);
      this.setAttribute("aria-hidden", "true");
      this.replaceChildren(
        ...Array.from({ length: SEGMENT_COUNT }, () => {
          const segment = document.createElement("span");
          segment.className = "task-voice-level-segment";
          return segment;
        }),
      );
      this.segments = Array.from(
        this.querySelectorAll(":scope > .task-voice-level-segment"),
      );
    }
    this.renderLevels();
  }

  setLevel(value) {
    const level = Math.min(1, Math.max(0, Number(value) || 0));
    this.level = level;
    this.dataset.level = level.toFixed(3);

    this.levels ??= Array(SEGMENT_COUNT).fill(0);
    this.levels.copyWithin(0, 1);
    this.levels[SEGMENT_COUNT - 1] = level;
    this.renderLevels();
  }

  renderLevels() {
    for (const [index, segment] of (this.segments ?? []).entries()) {
      const level = this.levels?.[index] ?? 0;
      segment.style.transform = `scaleY(${(MINIMUM_SCALE + level * (1 - MINIMUM_SCALE)).toFixed(3)})`;
      segment.style.opacity = (0.2 + level * 0.8).toFixed(3);
    }
  }
}

if (!customElements.get("caffold-voice-level-meter")) {
  customElements.define("caffold-voice-level-meter", CaffoldVoiceLevelMeter);
}
