import React, { useCallback, useRef } from 'react';
import './HueSlider.scss';

export interface HueSliderProps {
    hue: number;
    onChange: (hue: number) => void;
    disabled?: boolean;
    className?: string;
}

const HueSlider: React.FC<HueSliderProps> = ({
    hue,
    onChange,
    disabled = false,
    className = '',
}) => {
    const sliderRef = useRef<HTMLDivElement>(null);
    const draggingRef = useRef(false);

    const getHueFromPosition = useCallback((clientX: number): number => {
        const slider = sliderRef.current;
        if (!slider) return hue;
        const rect = slider.getBoundingClientRect();
        const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
        return Math.round((x / rect.width) * 360);
    }, [hue]);

    const handleMouseDown = useCallback(
        (e: React.MouseEvent) => {
            if (disabled) return;
            e.preventDefault();
            draggingRef.current = true;

            const newHue = getHueFromPosition(e.clientX);
            onChange(newHue);

            const handleMouseMove = (ev: MouseEvent) => {
                if (!draggingRef.current) return;
                const h = getHueFromPosition(ev.clientX);
                onChange(h);
            };

            const handleMouseUp = () => {
                draggingRef.current = false;
                window.removeEventListener('mousemove', handleMouseMove);
                window.removeEventListener('mouseup', handleMouseUp);
            };

            window.addEventListener('mousemove', handleMouseMove);
            window.addEventListener('mouseup', handleMouseUp);
        },
        [disabled, getHueFromPosition, onChange],
    );

    const thumbLeft = `${(hue / 360) * 100}%`;

    return (
        <div
            ref={sliderRef}
            className={`hue-slider ${disabled ? 'hue-slider--disabled' : ''} ${className}`}
            onMouseDown={handleMouseDown}
        >
            <div className="hue-slider__track" />
            <div
                className="hue-slider__thumb"
                style={{ left: thumbLeft }}
            >
                <div
                    className="hue-slider__thumb-inner"
                    style={{ backgroundColor: `hsl(${hue}, 72%, 65%)` }}
                />
            </div>
        </div>
    );
};

export default HueSlider;
