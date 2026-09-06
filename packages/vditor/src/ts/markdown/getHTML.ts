import {getMarkdown} from "./getMarkdown";
import {renderImageCaptionHTML} from "./imageCaptionRender";

export const getHTML = (vditor: IVditor) => {
    const html = vditor.lute.VditorDOM2HTML(vditor.wysiwyg.element.innerHTML);
    return renderImageCaptionHTML(html, vditor.options.preview.markdown.imageCaption);
};
