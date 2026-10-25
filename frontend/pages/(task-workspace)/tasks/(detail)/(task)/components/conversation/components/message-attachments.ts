import { html, LitElement, type PropertyValues } from "lit";
import { keyed } from "lit/directives/keyed.js";
import {
  type ActionHintScope,
  type ActionHintScopeOptions,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";
import { fetchInChunks } from "#app/chunked-fetch.ts";
import { inlineIcon, warmIcons } from "#components/icons.ts";
import "#components/loading-text.ts";
import { requestTaskImagePreview } from "#tasks/components/image-preview-dialog.js";

// A picture is fetched when it comes this near view, in the viewport and in
// the conversation that scrolls it: the distance Chrome itself keeps for a
// lazily loading image on a connection it cannot rate, or on 3G. `scrollMargin`
// is newer than TypeScript's DOM types.
const NEARBY_MARGIN = "2500px 0px";
const NEARBY_PICTURES: IntersectionObserverInit & { scrollMargin: string } = {
  rootMargin: NEARBY_MARGIN,
  scrollMargin: NEARBY_MARGIN,
};

const ATTACHMENT_ICONS = {
  image: ["FileImage", "Attached image", "task-message-attachment-icon"],
  unavailable: [
    "ImageOff",
    "Image preview unavailable",
    "task-message-attachment-placeholder-icon",
  ],
} as const;

// A picture to show: where it is read from (empty when it cannot be read) and
// its name.
export interface MessageAttachment {
  src: string;
  name: string;
}

interface FetchedPicture {
  fetching: AbortController;
  objectUrl: string;
}

/**
 * The pictures a message carries, each opening a larger preview.
 *
 * A prompt's images and an image the agent generated are shown the same way,
 * so both messages mount this list and hand it only the pictures to show. The
 * message places the list; `align-end` lines the pictures up on the side a
 * prompt sits on.
 *
 * A picture the server holds is fetched in cells once it nears the viewport
 * and drawn from that copy; a picture carried in the message itself is drawn
 * as it is. Other pictures are new nodes, so each starts from loading.
 */
export class CaffoldTaskMessageAttachments extends LitElement {
  static properties = {
    attachments: {
      attribute: false,
      hasChanged: (next: MessageAttachment[], previous?: MessageAttachment[]) =>
        JSON.stringify(next) !== JSON.stringify(previous),
    },
  };

  declare attachments: MessageAttachment[];
  private fetchedPictures = new Map<HTMLImageElement, FetchedPicture>();
  private pictureObserver: IntersectionObserver | null = null;
  private readonly iconsReady = () => this.requestUpdate();

  constructor() {
    super();
    this.attachments = [];
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    if (!this.hasAttribute("aria-label")) {
      this.setAttribute("aria-label", "Attached images");
    }
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
    if (this.hasUpdated) {
      this.watchPictures();
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
    this.releasePictures();
  }

  willUpdate(changed: PropertyValues<this>) {
    if (changed.has("attachments")) {
      this.releasePictures();
    }
  }

  render() {
    return keyed(
      this.attachments,
      this.attachments.map(
        (attachment, index) => html`
          <figure class="task-message-attachment">
            ${
              attachment.src
                ? html`<button
                    type="button"
                    class="task-message-attachment-preview"
                    data-attachment-action="preview"
                    data-attachment-index=${index}
                    aria-label=${`Preview ${attachment.name}`}
                    title="Preview image"
                    @click=${() => this.preview(index)}
                  >${picture(attachment.src)}</button>`
                : html`<div
                    class="task-message-attachment-preview
                      task-message-attachment-unavailable"
                  >
                    <span
                      class="task-message-attachment-icon-slot"
                      data-attachment-icon="unavailable"
                    >${attachmentIcon("unavailable")}</span>
                    <span>Preview unavailable</span>
                  </div>`
            }
            <figcaption title=${attachment.name}>
              <span
                class="task-message-attachment-icon-slot"
                data-attachment-icon="image"
              >${attachmentIcon("image")}</span>
              <span
                class="task-message-attachment-name"
              >${attachment.name}</span>
            </figcaption>
          </figure>
        `,
      ),
    );
  }

  updated(changed: PropertyValues<this>) {
    if (changed.has("attachments") && this.isConnected) {
      this.watchPictures();
    }
  }

  preview(index: number) {
    const attachment = this.attachments[index];
    if (attachment) {
      requestTaskImagePreview(this, attachment);
    }
  }

  actionHintScope({
    scopeId = "",
    clipRoots = [],
  }: ActionHintScopeOptions = {}): ActionHintScope {
    if (!scopeId || !this.isConnected || this.hidden) {
      return emptyActionHintScope();
    }
    const targetClipRoots = [this, ...clipRoots].filter(Boolean);
    return {
      blocked: false,
      targets: this.previewButtons.flatMap((control, index) =>
        hasActionHintLayoutBox(control)
          ? [
              buttonActionHintTarget({
                invalidationOwner: this,
                id: `${scopeId}:preview:${index + 1}`,
                actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                label: control.getAttribute("aria-label") || "Preview image",
                control,
                clipRoots: targetClipRoots,
                isActionable: () =>
                  this.isConnected &&
                  !this.hidden &&
                  this.previewButtons[index] === control &&
                  hasActionHintLayoutBox(control),
              }),
            ]
          : [],
      ),
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  watchPictures() {
    const pictures = this.querySelectorAll<HTMLImageElement>(
      ":scope > figure img[data-attachment-source]:not([src])",
    );
    if (!pictures.length) {
      return;
    }
    this.pictureObserver ??= new IntersectionObserver(
      (entries) => this.fetchNearbyPictures(entries),
      NEARBY_PICTURES,
    );
    // A picture is watched through its box: the picture stays hidden until
    // it is drawn, and a hidden element never comes near the viewport.
    for (const picture of pictures) {
      if (picture.parentElement) {
        this.pictureObserver.observe(picture.parentElement);
      }
    }
  }

  // A released picture loses its copy and goes back to loading, so the list
  // fetches it again if it is shown again.
  releasePictures() {
    this.pictureObserver?.disconnect();
    for (const [picture, record] of this.fetchedPictures) {
      record.fetching.abort();
      if (record.objectUrl) {
        URL.revokeObjectURL(record.objectUrl);
      }
      picture.removeAttribute("src");
      picture.hidden = true;
      const loading = pictureLoading(picture);
      if (loading) {
        loading.hidden = false;
      }
    }
    this.fetchedPictures.clear();
  }

  private fetchNearbyPictures(entries: IntersectionObserverEntry[]) {
    for (const { target: box, isIntersecting } of entries) {
      const picture = box.querySelector<HTMLImageElement>(
        ":scope > img[data-attachment-source]",
      );
      if (!isIntersecting || !picture || this.fetchedPictures.has(picture)) {
        continue;
      }
      this.pictureObserver?.unobserve(box);
      const fetching = new AbortController();
      const record: FetchedPicture = { fetching, objectUrl: "" };
      this.fetchedPictures.set(picture, record);
      fetchInChunks(picture.dataset.attachmentSource ?? "", {
        signal: fetching.signal,
      }).then(
        ({ file }) => {
          if (this.fetchedPictures.get(picture) !== record) {
            return;
          }
          record.objectUrl = URL.createObjectURL(file);
          picture.addEventListener(
            "load",
            () => {
              picture.hidden = false;
              const loading = pictureLoading(picture);
              if (loading) {
                loading.hidden = true;
              }
            },
            { once: true },
          );
          picture.src = record.objectUrl;
        },
        (error: unknown) => {
          const loading = pictureLoading(picture);
          if (
            this.fetchedPictures.get(picture) === record &&
            !(error instanceof DOMException && error.name === "AbortError") &&
            loading
          ) {
            loading.hidden = true;
          }
        },
      );
    }
  }

  private get previewButtons() {
    return Array.from(
      this.querySelectorAll<HTMLButtonElement>(
        ':scope > figure > button[data-attachment-action="preview"]',
      ),
    );
  }
}

// Until a fetched picture is drawn, its place says it is loading rather than
// standing empty. The template leaves the picture's `src` and `hidden` to
// the fetch.
function picture(src: string) {
  return src.startsWith("data:")
    ? html`<img src=${src} alt="">`
    : html`
        <img data-attachment-source=${src} alt="" hidden>
        <caffold-loading-text>Loading image...</caffold-loading-text>
      `;
}

function pictureLoading(picture: HTMLImageElement) {
  return (
    picture.parentElement?.querySelector<HTMLElement>(
      ":scope > caffold-loading-text",
    ) ?? null
  );
}

function attachmentIcon(kind: keyof typeof ATTACHMENT_ICONS) {
  const [name, label, className] = ATTACHMENT_ICONS[kind];
  return inlineIcon(name, label, className);
}

customElements.define(
  "caffold-task-message-attachments",
  CaffoldTaskMessageAttachments,
);
