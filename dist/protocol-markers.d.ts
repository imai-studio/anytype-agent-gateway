export declare const PROTOCOL_MARKER_NAMESPACES: readonly ["KNOT", "AAG"];
export declare const silenceMarker: RegExp;
export declare const replyMarker: RegExp;
export declare const mentionMarker: RegExp;
export declare const objectMarker: RegExp;
export declare const objectCardMarker: RegExp;
export declare function parseSilenceMarker(text: string): {
    reason?: string;
} | undefined;
