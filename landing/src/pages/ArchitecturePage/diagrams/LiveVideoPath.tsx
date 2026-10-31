import { Arrow, Box, Caption, LINE, MONO, MUTED } from "./primitives";

export function LiveVideoPath() {
  return (
    <svg
      viewBox="0 0 920 300"
      className="h-auto w-full"
      role="img"
      aria-label="A live video stream encoded, protected with parity and paced onto the mesh, then rebuilt and played on each phone that receives it"
    >
      <Arrow id="lv-arrow" />
      <Caption x={16} y={24}>
        ON THE PHONE GOING LIVE
      </Caption>
      <Box x={16} y={36} w={120} h={60} label="camera + mic" strong />
      <line x1={140} y1={66} x2={170} y2={66} stroke={LINE} markerEnd="url(#lv-arrow)" />
      <Box x={174} y={36} w={150} h={60} label="encoder" sub="H.264 + AAC-LC" />
      <line x1={328} y1={66} x2={358} y2={66} stroke={LINE} markerEnd="url(#lv-arrow)" />
      <Box x={362} y={36} w={170} h={60} label="blocks + parity" sub="Reed-Solomon" />
      <line x1={536} y1={66} x2={566} y2={66} stroke={LINE} markerEnd="url(#lv-arrow)" />
      <Box x={570} y={36} w={150} h={60} label="0x2D packets" sub="352 bytes at most" />
      <line x1={724} y1={66} x2={754} y2={66} stroke={LINE} markerEnd="url(#lv-arrow)" />
      <Box x={758} y={36} w={148} h={60} label="pacer" sub="held to the route" />

      <Caption x={16} y={166}>
        ON EVERY PHONE THAT RECEIVES IT
      </Caption>
      <Box x={16} y={178} w={180} h={60} label="rebuild" sub="any k of k + r" />
      <line x1={200} y1={208} x2={230} y2={208} stroke={LINE} markerEnd="url(#lv-arrow)" />
      <Box x={234} y={178} w={170} h={60} label="playout" sub="350 ms behind" />
      <line x1={408} y1={208} x2={438} y2={208} stroke={LINE} markerEnd="url(#lv-arrow)" />
      <Box x={442} y={178} w={200} h={60} label="screen" sub="while the chat is open" strong />
      <line x1={646} y1={208} x2={676} y2={208} stroke={LINE} markerEnd="url(#lv-arrow)" />
      <Box x={680} y={178} w={226} h={60} label="recording" sub="kept when the stream ends" />

      <text x={16} y={272} fontFamily={MONO} fontSize={10} fill={MUTED}>
        Rebuilding and recording happen whether or not anyone is watching. Decoding to the screen
        does not, which is
      </text>
      <text x={16} y={288} fontFamily={MONO} fontSize={10} fill={MUTED}>
        what keeps a phone that only passes the stream along from paying for the picture.
      </text>
    </svg>
  );
}
