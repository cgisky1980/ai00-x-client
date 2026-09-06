import {code160to32} from "../util/code160to32";

export const getMarkdown = (vditor: IVditor) => {
    return code160to32(vditor.lute.VditorDOM2Md(vditor.wysiwyg.element.innerHTML));
};
