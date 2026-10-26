import { html, LitElement } from "lit";

const SEGMENT_COUNT = 16;
const MINIMUM_SCALE = 0.18;

// How loud the microphone has been over the last sixteen readings, newest on
// the right. A reading arrives every tenth of a second while recording, and
// each one moves the bars by writing their style rather than drawing again.
export class CaffoldVoiceLevelMeter extends LitElement {
  level = 0;
  private levels = new Array<number>(SEGMENT_COUNT).fill(0);

  createRenderRoot() {
    return this;
  }

  render() {
    return Array.from(
      { length: SEGMENT_COUNT },
      () => html`<span class="task-voice-level-segment"></span>`,
    );
  }

  firstUpdated() {
    this.setAttribute("aria-hidden", "true");
    this.drawLevels();
  }

  setLevel(value: number) {
    const level = Math.min(1, Math.max(0, Number(value) || 0));
    this.level = level;
    this.dataset.level = level.toFixed(3);
    this.levels.copyWithin(0, 1);
    this.levels[SEGMENT_COUNT - 1] = level;
    this.drawLevels();
  }

  // A new recording starts from silence rather than the last one's levels.
  reset() {
    this.level = 0;
    delete this.dataset.level;
    this.levels = new Array<number>(SEGMENT_COUNT).fill(0);
    this.drawLevels();
  }

  private drawLevels() {
    const segments = [...this.children] as HTMLElement[];
    for (const [index, segment] of segments.entries()) {
      const level = this.levels[index] ?? 0;
      const scale = MINIMUM_SCALE + level * (1 - MINIMUM_SCALE);
      segment.style.transform = `scaleY(${scale.toFixed(3)})`;
      segment.style.opacity = (0.2 + level * 0.8).toFixed(3);
    }
  }
}

customElements.define("caffold-voice-level-meter", CaffoldVoiceLevelMeter);
