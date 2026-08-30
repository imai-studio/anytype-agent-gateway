export const PROTOCOL_MARKER_NAMESPACES = ["KNOT", "AAG"];
export const silenceMarker = /^\s*\[\[(?:KNOT|AAG)_STAY_SILENT(?::\s*(.*?))?\]\]\s*$/s;
export const replyMarker = /^\s*\[\[(?:KNOT|AAG)_REPLY\]\]\s*/i;
export const mentionMarker = /\[\[(?:KNOT|AAG)_MENTION:([^\]\n]+)\]\]/gi;
export const objectMarker = /^\[\[(?:KNOT|AAG)_OBJECT:([^|\]\n]+)\|([^\]\n]+)\]\]/i;
export const objectCardMarker = /^\[\[(?:KNOT|AAG)_OBJECT_CARD:([^|\]\n]+)\|([^\]\n]+)\]\]/i;
export function parseSilenceMarker(text) {
    const match = silenceMarker.exec(text);
    return match ? (match[1] ? { reason: match[1] } : {}) : undefined;
}
