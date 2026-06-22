export function KidneyIllustration() {
  return (
    <svg
      viewBox="0 0 200 200"
      className="w-full h-full"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Cuerpo del riñón */}
      <path
        d="M 100 20
           C 140 20, 168 48, 168 90
           C 168 132, 150 165, 118 178
           C 107 182, 96 178, 88 168
           C 78 156, 76 136, 80 112
           C 84 88, 96 76, 96 56
           C 96 36, 98 20, 100 20 Z"
        fill="#1a2235"
        stroke="#2dd4bf"
        strokeWidth="2.5"
      />

      {/* Seno renal (pelvis) */}
      <path
        d="M 104 58
           C 120 58, 138 72, 138 92
           C 138 112, 126 132, 108 136
           C 98 138, 90 132, 88 120
           C 86 106, 92 90, 98 80
           C 102 72, 102 58, 104 58 Z"
        fill="#0f1117"
        stroke="#2dd4bf"
        strokeWidth="1.2"
        opacity="0.85"
      />

      {/* Líneas de scan TC */}
      <line x1="68"  y1="62"  x2="165" y2="62"  stroke="#2dd4bf" strokeWidth="0.8" opacity="0.3" />
      <line x1="60"  y1="80"  x2="168" y2="80"  stroke="#2dd4bf" strokeWidth="0.8" opacity="0.3" />
      <line x1="56"  y1="98"  x2="168" y2="98"  stroke="#2dd4bf" strokeWidth="0.8" opacity="0.3" />
      <line x1="58"  y1="116" x2="166" y2="116" stroke="#2dd4bf" strokeWidth="0.8" opacity="0.3" />
      <line x1="66"  y1="134" x2="160" y2="134" stroke="#2dd4bf" strokeWidth="0.8" opacity="0.3" />
      <line x1="82"  y1="152" x2="148" y2="152" stroke="#2dd4bf" strokeWidth="0.8" opacity="0.3" />

      {/* Halo del tumor */}
      <circle cx="142" cy="82" r="18" fill="#ffcf26" opacity="0.13" stroke="#ffcf26" strokeWidth="1.2" />
      {/* Tumor */}
      <circle cx="142" cy="82" r="8"  fill="#ffcf26" opacity="0.9" />

      {/* Crosshair */}
      <line x1="142" y1="60"  x2="142" y2="72"  stroke="#ffcf26" strokeWidth="1.4" opacity="0.9" />
      <line x1="142" y1="92"  x2="142" y2="104" stroke="#ffcf26" strokeWidth="1.4" opacity="0.9" />
      <line x1="120" y1="82"  x2="132" y2="82"  stroke="#ffcf26" strokeWidth="1.4" opacity="0.9" />
      <line x1="152" y1="82"  x2="164" y2="82"  stroke="#ffcf26" strokeWidth="1.4" opacity="0.9" />
    </svg>
  );
}
