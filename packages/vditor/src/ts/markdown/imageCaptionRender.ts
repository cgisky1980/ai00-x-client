const getContentNodes = (element: Element, ignoreIRMarkers = false) => {
    return Array.from(element.childNodes).filter((node) => {
        if (node.nodeType === Node.COMMENT_NODE) {
            return false;
        }
        if (node.nodeType === Node.TEXT_NODE) {
            return node.textContent.replace(/\u200b/g, "").trim() !== "";
        }
        if (!(node instanceof HTMLElement)) {
            return true;
        }
        if (node.tagName === "WBR") {
            return false;
        }
        return !ignoreIRMarkers || !node.classList.contains("vditor-ir__marker");
    });
};

const getWYSIWYGImage = (paragraph: HTMLParagraphElement) => {
    const nodes = getContentNodes(paragraph);
    if (nodes.length !== 1 || !(nodes[0] instanceof HTMLElement)) {
        return undefined;
    }

    const container = nodes[0];
    if (container instanceof HTMLImageElement) {
        return {
            container,
            image: container,
        };
    }
    if (container instanceof HTMLAnchorElement) {
        const linkNodes = getContentNodes(container);
        if (linkNodes.length === 1 && linkNodes[0] instanceof HTMLImageElement) {
            return {
                container,
                image: linkNodes[0],
            };
        }
    }
    return undefined;
};

const unwrapWYSIWYGCaptions = (element: HTMLElement) => {
    element.querySelectorAll("span.vditor-image[data-image-caption]").forEach((wrapper) => {
        while (wrapper.firstChild) {
            wrapper.parentNode.insertBefore(wrapper.firstChild, wrapper);
        }
        wrapper.remove();
    });
};

const renderPreviewCaptions = (element: HTMLElement) => {
    element.querySelectorAll("p").forEach((paragraph: HTMLParagraphElement) => {
        const imageData = getWYSIWYGImage(paragraph);
        const caption = imageData?.image.getAttribute("title")?.trim();
        if (!imageData || !caption) {
            return;
        }

        const figure = document.createElement("figure");
        Array.from(paragraph.attributes).forEach((attribute) => {
            figure.setAttribute(attribute.name, attribute.value);
        });
        figure.classList.add("vditor-image");
        const figcaption = document.createElement("figcaption");
        figcaption.textContent = caption;
        figure.append(imageData.container, figcaption);
        paragraph.replaceWith(figure);
    });
};

const renderWYSIWYGCaptions = (element: HTMLElement) => {
    element.querySelectorAll("p").forEach((paragraph: HTMLParagraphElement) => {
        const imageData = getWYSIWYGImage(paragraph);
        const caption = imageData?.image.getAttribute("title")?.trim();
        if (!imageData || !caption) {
            return;
        }

        const wrapper = document.createElement("span");
        wrapper.className = "vditor-image";
        wrapper.setAttribute("data-image-caption", caption);
        imageData.container.replaceWith(wrapper);
        wrapper.append(imageData.container);
    });
};

export const renderImageCaptions = (
    element: HTMLElement,
    mode: "preview" | "wysiwyg",
    enable: boolean,
) => {
    if (mode === "wysiwyg") {
        unwrapWYSIWYGCaptions(element);
    }
    if (!enable) {
        return;
    }

    if (mode === "preview") {
        renderPreviewCaptions(element);
    } else {
        renderWYSIWYGCaptions(element);
    }
};

export const renderImageCaptionHTML = (html: string, enable: boolean) => {
    if (!enable) {
        return html;
    }
    const container = document.createElement("div");
    container.innerHTML = html;
    renderImageCaptions(container, "preview", true);
    return container.innerHTML;
};
