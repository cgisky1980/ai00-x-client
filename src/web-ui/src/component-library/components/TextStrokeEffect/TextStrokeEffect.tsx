"use client";

import React from "react";
import "./TextStrokeEffect.scss";

export interface TextStrokeEffectProps {
  text: string;
  duration?: number;
  className?: string;
  height?: string;
}

/**
 * Text stroke loop animation component
 * Pure CSS implementation, no extra animation libraries
 */
export const TextStrokeEffect: React.FC<TextStrokeEffectProps> = ({
  text,
  duration = 4,
  className = "",
  height = "100px",
}) => {
  const charWidth = 55;
  const viewBoxWidth = text.length * charWidth;
  const viewBoxHeight = 100;

  return (
    <svg
      className={`text-stroke-effect ${className}`}
      viewBox={`0 0 ${viewBoxWidth} ${viewBoxHeight}`}
      xmlns="http://www.w3.org/2000/svg"
      style={{ 
        height: height,
        width: 'auto',
        display: 'block',
      }}
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <linearGradient id="textStrokeGradient" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#eab308">
            <animate
              attributeName="stop-color"
              values="#eab308; #ef4444; #3b82f6; #06b6d4; #8b5cf6; #eab308"
              dur={`${duration}s`}
              repeatCount="indefinite"
            />
          </stop>
          <stop offset="25%" stopColor="#ef4444">
            <animate
              attributeName="stop-color"
              values="#ef4444; #3b82f6; #06b6d4; #8b5cf6; #eab308; #ef4444"
              dur={`${duration}s`}
              repeatCount="indefinite"
            />
          </stop>
          <stop offset="50%" stopColor="#3b82f6">
            <animate
              attributeName="stop-color"
              values="#3b82f6; #06b6d4; #8b5cf6; #eab308; #ef4444; #3b82f6"
              dur={`${duration}s`}
              repeatCount="indefinite"
            />
          </stop>
          <stop offset="75%" stopColor="#06b6d4">
            <animate
              attributeName="stop-color"
              values="#06b6d4; #8b5cf6; #eab308; #ef4444; #3b82f6; #06b6d4"
              dur={`${duration}s`}
              repeatCount="indefinite"
            />
          </stop>
          <stop offset="100%" stopColor="#8b5cf6">
            <animate
              attributeName="stop-color"
              values="#8b5cf6; #eab308; #ef4444; #3b82f6; #06b6d4; #8b5cf6"
              dur={`${duration}s`}
              repeatCount="indefinite"
            />
          </stop>
        </linearGradient>
      </defs>

      <text
        x="50%"
        y="55%"
        textAnchor="middle"
        dominantBaseline="middle"
        className="text-stroke-effect__outline"
      >
        {text}
      </text>

      <text
        x="50%"
        y="55%"
        textAnchor="middle"
        dominantBaseline="middle"
        className="text-stroke-effect__animated"
        style={{
          animationDuration: `${duration}s`,
        }}
      >
        {text}
      </text>

      <text
        x="50%"
        y="55%"
        textAnchor="middle"
        dominantBaseline="middle"
        className="text-stroke-effect__gradient"
        stroke="url(#textStrokeGradient)"
      >
        {text}
      </text>
    </svg>
  );
};

export default TextStrokeEffect;
