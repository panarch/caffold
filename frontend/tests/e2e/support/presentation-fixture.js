import JSZip from "jszip";
import PptxGenJS from "pptxgenjs";

const AUDIO_RELATIONSHIP =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/audio";

// Builds a deck with pptxgenjs, which writes the masters, layouts, and theme a
// slide needs, and returns its .pptx bytes. `build` adds the slides to the
// presentation it is given. pptxgenjs stores an audio clip as a video file;
// PowerPoint stores it as an audio file, which is what this writes.
export async function presentationDeck(build) {
  const presentation = new PptxGenJS();
  build(presentation);
  const zip = await JSZip.loadAsync(
    await presentation.write({ outputType: "nodebuffer" }),
  );
  for (const path of Object.keys(zip.files)) {
    const slide = path.match(/^ppt\/slides\/(slide\d+\.xml)$/)?.[1];
    if (!slide) {
      continue;
    }
    const relationships = await zip.file(`ppt/slides/_rels/${slide}.rels`).async("string");
    const audio = [...relationships.matchAll(/<Relationship\b[^>]*>/g)]
      .map(([element]) => element)
      .filter((element) => element.includes(`Type="${AUDIO_RELATIONSHIP}"`))
      .map((element) => element.match(/\bId="([^"]+)"/)[1]);
    let xml = await zip.file(path).async("string");
    for (const id of audio) {
      xml = xml.replace(`<a:videoFile r:link="${id}"/>`, `<a:audioFile r:link="${id}"/>`);
    }
    zip.file(path, xml);
  }
  return zip.generateAsync({ type: "nodebuffer" });
}
