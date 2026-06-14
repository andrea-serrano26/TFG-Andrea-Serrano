export function KidneyIllustration() {
  return (
    <svg
      viewBox="0 0 200 200"
      className="w-full h-full"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Riñón izquierdo */}
      <g>
        <path
          d="M 60 70 C 45 70, 35 85, 35 100 C 35 115, 40 130, 50 140 C 55 145, 60 147, 65 145 C 70 143, 72 138, 72 130 L 72 110 C 72 102, 70 95, 65 90 C 62 87, 62 82, 65 78 C 68 74, 64 70, 60 70 Z"
          fill="#ffcf26"
          opacity="0.3"
          stroke="#ffcf26"
          strokeWidth="2"
        />
        <ellipse
          cx="55"
          cy="105"
          rx="8"
          ry="10"
          fill="#ffcf26"
          opacity="0.5"
        />
      </g>

      {/* Riñón derecho con tumor */}
      <g>
        <path
          d="M 140 70 C 155 70, 165 85, 165 100 C 165 115, 160 130, 150 140 C 145 145, 140 147, 135 145 C 130 143, 128 138, 128 130 L 128 110 C 128 102, 130 95, 135 90 C 138 87, 138 82, 135 78 C 132 74, 136 70, 140 70 Z"
          fill="#ffcf26"
          opacity="0.3"
          stroke="#ffcf26"
          strokeWidth="2"
        />
        <ellipse
          cx="145"
          cy="105"
          rx="8"
          ry="10"
          fill="#ffcf26"
          opacity="0.5"
        />
        {/* Tumor (bolita) */}
        <circle
          cx="155"
          cy="95"
          r="8"
          fill="#38e8d7"
          opacity="0.7"
          stroke="#38e8d7"
          strokeWidth="2"
        />
        <circle
          cx="155"
          cy="95"
          r="4"
          fill="#38e8d7"
          opacity="0.9"
        />
      </g>

      {/* Líneas de detalle anatómico */}
      <line
        x1="55"
        y1="95"
        x2="55"
        y2="115"
        stroke="#ffcf26"
        strokeWidth="1.5"
        opacity="0.6"
      />
      <line
        x1="145"
        y1="95"
        x2="145"
        y2="115"
        stroke="#ffcf26"
        strokeWidth="1.5"
        opacity="0.6"
      />
    </svg>
  );
}
