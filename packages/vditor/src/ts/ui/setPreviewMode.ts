import {removeCurrentToolbar, setCurrentToolbar} from "../toolbar/setToolbar";

export const setPreviewMode = (mode: "both" | "editor", vditor: IVditor) => {
    if (vditor.options.preview.mode === mode) {
        return;
    }
    vditor.options.preview.mode = mode;

    if (mode === "both") {
        vditor.wysiwyg.element.parentElement.style.display = "none";
        vditor.preview.element.style.display = "block";
        vditor.preview.render(vditor);

        setCurrentToolbar(vditor.toolbar.elements, ["both"]);
    } else {
        vditor.wysiwyg.element.parentElement.style.display = "block";
        vditor.preview.element.style.display = "none";

        removeCurrentToolbar(vditor.toolbar.elements, ["both"]);
    }

    if (vditor.devtools) {
        vditor.devtools.renderEchart(vditor);
    }
};
