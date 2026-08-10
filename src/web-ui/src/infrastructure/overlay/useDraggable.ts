import { useState, useRef, useEffect, useCallback } from 'react';
import { refreshRegions } from './mouseThrough';

interface Position {
    x: number;
    y: number;
}

interface UseDraggableOptions {
    initialPosition?: Position;
    excludeSelector?: string;
    onDragStart?: () => void;
    onDragEnd?: () => void;
}

export function useDraggable(options: UseDraggableOptions = {}) {
    const {
        initialPosition = { x: 0, y: 0 },
        excludeSelector,
        onDragStart,
        onDragEnd,
    } = options;

    const [position, setPosition] = useState<Position>(initialPosition);
    const [isDragging, setIsDragging] = useState(false);
    const dragOffset = useRef<Position>({ x: 0, y: 0 });
    const elementRef = useRef<HTMLDivElement | null>(null);
    const moveCountRef = useRef(0);

    const handleMouseDown = useCallback(
        (e: React.MouseEvent) => {
            if (excludeSelector && (e.target as HTMLElement).closest(excludeSelector)) {
                return;
            }

            const element = elementRef.current;
            if (!element) return;

            const rect = element.getBoundingClientRect();
            dragOffset.current = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top,
            };

            setIsDragging(true);
            onDragStart?.();
        },
        [excludeSelector, onDragStart],
    );

    useEffect(() => {
        if (!isDragging) return;

        const handleMouseMove = (e: MouseEvent) => {
            setPosition({
                x: e.clientX - dragOffset.current.x,
                y: e.clientY - dragOffset.current.y,
            });
            moveCountRef.current++;
            if (moveCountRef.current % 3 === 0) {
                refreshRegions();
            }
        };

        const handleMouseUp = () => {
            setIsDragging(false);
            moveCountRef.current = 0;
            onDragEnd?.();
            refreshRegions();
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);

        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isDragging, onDragEnd]);

    const centerPosition = useCallback((element: HTMLDivElement | null) => {
        if (!element) return;
        const rect = element.getBoundingClientRect();
        setPosition({
            x: (window.innerWidth - rect.width) / 2,
            y: (window.innerHeight - rect.height) / 2,
        });
        setTimeout(() => refreshRegions(), 50);
    }, []);

    return {
        position,
        setPosition,
        isDragging,
        elementRef,
        handleMouseDown,
        centerPosition,
    };
}
