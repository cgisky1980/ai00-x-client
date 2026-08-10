import { invoke } from '@tauri-apps/api/core';

interface Region {
    x: number;
    y: number;
    width: number;
    height: number;
}

let updateTimeout: ReturnType<typeof setTimeout> | null = null;
let isDragging = false;
let draggingRegion: Region | null = null;
let periodicTimer: ReturnType<typeof setInterval> | null = null;
let mutationObserver: MutationObserver | null = null;
let resizeObserver: ResizeObserver | null = null;

export function setDragging(dragging: boolean) {
    isDragging = dragging;
    if (!dragging) {
        draggingRegion = null;
    }
}

export function setDraggingRegion(region: Region | null) {
    draggingRegion = region;
    if (isDragging && region) {
        updateRegions();
    }
}

function getMarkedRegions(): Region[] {
    if (isDragging && draggingRegion) {
        return [draggingRegion];
    }

    const regions: Region[] = [];
    const elements = document.querySelectorAll('.no-penetrate, [data-no-penetrate]');

    elements.forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            regions.push({
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
            });
        }
    });

    return regions;
}

async function updateRegions() {
    const regions = getMarkedRegions();
    try {
        await invoke('set_no_penetrate_regions', { regions });
    } catch (err) {
        console.error('Failed to update regions:', err);
    }
}

export function refreshRegions() {
    updateRegions();
}

function debouncedUpdate() {
    if (updateTimeout) {
        clearTimeout(updateTimeout);
    }
    updateTimeout = setTimeout(updateRegions, 50);
}

export function initMouseThrough(): () => void {
    resizeObserver = new ResizeObserver(debouncedUpdate);
    resizeObserver.observe(document.body);

    mutationObserver = new MutationObserver(debouncedUpdate);
    mutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'data-no-penetrate'],
    });

    periodicTimer = setInterval(refreshRegions, 2000);

    updateRegions();

    return () => {
        if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver = null;
        }
        if (mutationObserver) {
            mutationObserver.disconnect();
            mutationObserver = null;
        }
        if (periodicTimer) {
            clearInterval(periodicTimer);
            periodicTimer = null;
        }
        if (updateTimeout) {
            clearTimeout(updateTimeout);
            updateTimeout = null;
        }
    };
}
