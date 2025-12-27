import React from "react";

type TokenGapProps = {
  index: number;
  width: number;
  height: number;
  markerChar: string | null;
  markerStyle: React.CSSProperties;
  isActive: boolean;
  onDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
  onDrop: () => void;
};

export const TokenGap: React.FC<TokenGapProps> = ({
  index,
  width,
  height,
  markerChar,
  markerStyle,
  isActive,
  onDragOver,
  onDrop,
}) => (
  <div
    data-drop-index={index}
    style={{
      width,
      height,
      display: "flex",
      alignItems: "flex-end",
      justifyContent: "center",
      flex: "0 0 auto",
      position: "relative",
    }}
    onDragOver={onDragOver}
    onDrop={(event) => {
      event.preventDefault();
      onDrop();
    }}
  >
    {isActive && (
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          left: "50%",
          top: -6,
          bottom: -6,
          width: 2,
          background: "rgba(94,234,212,0.85)",
          boxShadow: "0 0 0 1px rgba(94,234,212,0.5)",
          transform: "translateX(-50%)",
        }}
      />
    )}
    {markerChar && (
      <span aria-hidden="true" data-testid="space-marker" style={markerStyle}>
        {markerChar}
      </span>
    )}
  </div>
);
