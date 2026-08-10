import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useDraggable } from '@/infrastructure/overlay/useDraggable';
import { refreshRegions, setDragging } from '@/infrastructure/overlay/mouseThrough';
import { getOverlayZBase, getOverlayZFocused } from '@/infrastructure/overlay/overlayFocus';
import { PortalContainerProvider } from '@/infrastructure/contexts/PortalContainerContext';
import { useOverlayControlStore } from '@/app/stores/overlayControlStore';
import { WindowControls } from '@/component-library';
import './SettingsDialog.scss';

interface SettingsDialogProps {
    children: React.ReactNode;
    title?: string;
    defaultWidth?: number;
    defaultHeight?: number;
    onClose?: () => void;
    titlebarExtra?: React.ReactNode;
}

const DEFAULT_WIDTH = 900;
const DEFAULT_HEIGHT = 600;

const SettingsDialog: React.FC<SettingsDialogProps> = ({
    children,
    title = 'Ai00-X',
    defaultWidth = DEFAULT_WIDTH,
    defaultHeight = DEFAULT_HEIGHT,
    onClose,
    titlebarExtra,
}) => {
    const [size, setSize] = useState({ width: defaultWidth, height: defaultHeight });
    const [isResizing, setIsResizing] = useState(false);
    const focusedPanel = useOverlayControlStore((s) => s.focusedPanel);
    const setFocusedPanel = useOverlayControlStore((s) => s.setFocusedPanel);
    const zIndex = focusedPanel === 'settings-dialog' ? getOverlayZFocused() : getOverlayZBase();
    const resizeStartRef = useRef({ x: 0, y: 0, width: 0, height: 0 });
    const dialogRef = useRef<HTMLDivElement | null>(null);
    const [settingsPortalContainer, setSettingsPortalContainer] = useState<HTMLDivElement | null>(null);

    const { position, elementRef, handleMouseDown, centerPosition } = useDraggable({
        initialPosition: {
            x: Math.max(0, (window.innerWidth - defaultWidth) / 2),
            y: Math.max(0, (window.innerHeight - defaultHeight) / 2),
        },
        excludeSelector: '.settings-dialog__content, .settings-dialog__controls',
        onDragStart: () => setDragging(true),
        onDragEnd: () => setDragging(false),
    });

    useEffect(() => {
        if (elementRef.current) {
            centerPosition(elementRef.current);
        }
    }, [elementRef, centerPosition]);

    useEffect(() => {
        const timeout = setTimeout(() => refreshRegions(), 200);
        return () => clearTimeout(timeout);
    }, [position, size]);

    const handleResizeMouseDown = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setIsResizing(true);
            resizeStartRef.current = {
                x: e.clientX,
                y: e.clientY,
                width: size.width,
                height: size.height,
            };
            setDragging(true);
        },
        [size],
    );

    useEffect(() => {
        if (!isResizing) return;

        const handleMouseMove = (e: MouseEvent) => {
            const dx = e.clientX - resizeStartRef.current.x;
            const dy = e.clientY - resizeStartRef.current.y;
            setSize({
                width: Math.max(600, resizeStartRef.current.width + dx),
                height: Math.max(400, resizeStartRef.current.height + dy),
            });
        };

        const handleMouseUp = () => {
            setIsResizing(false);
            setDragging(false);
            refreshRegions();
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isResizing]);

    const setDialogRef = useCallback(
        (el: HTMLDivElement | null) => {
            elementRef.current = el;
            dialogRef.current = el;
        },
        [elementRef],
    );

    return (
        <div
            ref={setDialogRef}
            className={`settings-dialog no-penetrate ${isResizing ? 'settings-dialog--resizing' : ''}`}
            data-no-penetrate="true"
            tabIndex={-1}
            onMouseDown={() => setFocusedPanel('settings-dialog')}
            style={{
                left: position.x,
                top: position.y,
                width: size.width,
                height: size.height,
                zIndex,
            }}
        >
            <div className="settings-dialog__titlebar" onMouseDown={handleMouseDown}>
                <span className="settings-dialog__title">{title}</span>
                {titlebarExtra && (
                    <div className="settings-dialog__titlebar-extra" onMouseDown={(e) => e.stopPropagation()}>
                        {titlebarExtra}
                    </div>
                )}
                <div className="settings-dialog__controls">
                    <WindowControls
                        onClose={onClose || (() => {})}
                        showMinimize={false}
                        showMaximize={false}
                    />
                </div>
            </div>
            <div className="settings-dialog__content">
                <PortalContainerProvider container={settingsPortalContainer}>
                    {children}
                </PortalContainerProvider>
                <div ref={setSettingsPortalContainer} className="settings-dialog__portal-container" />
            </div>
            <div className="settings-dialog__resize-handle" onMouseDown={handleResizeMouseDown} />
        </div>
    );
};

export default SettingsDialog;
