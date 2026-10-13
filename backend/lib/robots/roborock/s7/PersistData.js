const zlib = require("zlib");

const PAYLOAD_SIZE = 1306912;
const CHUNK_SIZES = [9312, 90008, 131080, 262168, 1184780, PAYLOAD_SIZE];

// Wire-format editing deliberately preserves unknown fields and untouched chunks.
function readVarint(buffer, offset) {
    let value = 0;
    let multiplier = 1;
    for (let i = 0; i < 10 && offset < buffer.length; i++) {
        const byte = buffer[offset++];
        value += (byte & 127) * multiplier;
        if (!Number.isSafeInteger(value)) {
            throw new Error("Unsupported protobuf integer");
        }
        if (!(byte & 128)) {
            return {value: value, offset: offset};
        }
        multiplier *= 128;
    }
    throw new Error("Truncated protobuf integer");
}

function varint(value) {
    const bytes = [];
    do {
        const byte = value % 128;
        value = Math.floor(value / 128);
        bytes.push(byte | (value ? 128 : 0));
    } while (value);
    return Buffer.from(bytes);
}

function fields(buffer) {
    const result = [];
    let offset = 0;
    while (offset < buffer.length) {
        const start = offset;
        const tag = readVarint(buffer, offset);
        offset = tag.offset;
        const number = Math.floor(tag.value / 8);
        const wire = tag.value % 8;
        let dataStart = offset;
        let value;
        if (!number) {
            throw new Error("Invalid protobuf field");
        }
        if (wire === 0) {
            const integer = readVarint(buffer, offset);
            value = integer.value;
            offset = integer.offset;
        } else if (wire === 2) {
            const length = readVarint(buffer, offset);
            dataStart = length.offset;
            offset = dataStart + length.value;
        } else if (wire === 1 || wire === 5) {
            offset += wire === 1 ? 8 : 4;
        } else {
            throw new Error("Unsupported protobuf wire type");
        }
        if (offset > buffer.length) {
            throw new Error("Truncated protobuf field");
        }
        result.push({number: number, wire: wire, value: value, start: start,
            tagEnd: tag.offset, dataStart: dataStart, end: offset});
    }
    return result;
}

function one(records, number, wire) {
    const matches = records.filter(record => record.number === number);
    if (matches.length !== 1 || matches[0].wire !== wire) {
        throw new Error(`Missing or ambiguous persistence field ${number}`);
    }
    return matches[0];
}

function parse(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length > 2 * 1024 * 1024) {
        throw new Error("Invalid persistence container size");
    }
    const chunks = fields(buffer).filter(field => field.number === 20);
    if (chunks.length !== 6 || chunks.some(chunk => chunk.wire !== 2)) {
        throw new Error("Unsupported persistence container layout");
    }
    const sizes = [];
    let shared;
    for (const outer of chunks) {
        const innerBuffer = buffer.subarray(outer.dataStart, outer.end);
        const inner = fields(innerBuffer);
        const id = one(inner, 10, 0).value;
        const size = one(inner, 40, 0).value;
        const stream = one(inner, 50, 2);
        if (!CHUNK_SIZES.includes(size) || one(inner, 20, 0).value !== 1 || one(inner, 30, 0).value !== 1) {
            throw new Error("Unsupported persistence chunk layout");
        }
        const compressed = innerBuffer.subarray(stream.dataStart, stream.end);
        const inflated = /** @type {{buffer: Buffer, engine: {bytesWritten: number}}} */ (
            /** @type {unknown} */ (zlib.inflateSync(compressed, {maxOutputLength: size, info: true}))
        );
        const payload = inflated.buffer;
        if (payload.length !== size || inflated.engine.bytesWritten !== compressed.length) {
            throw new Error("Persistence chunk length mismatch");
        }
        sizes.push(size);
        if (id === 5) {
            if (shared || size !== PAYLOAD_SIZE) {
                throw new Error("Ambiguous SharedMapInfo chunk");
            }
            shared = {outer: outer, innerBuffer: innerBuffer, stream: stream, payload: payload};
        }
    }
    if (!shared || sizes.sort((a, b) => a - b).join() !== CHUNK_SIZES.join()) {
        throw new Error("Unsupported S7 persistence profile");
    }
    const pose = {x: shared.payload.readUInt16LE(0x10), y: shared.payload.readUInt16LE(0x12),
        angle: shared.payload.readFloatLE(0x14)};
    if (!Number.isFinite(pose.angle) || Math.abs(pose.angle) > 2 * Math.PI) {
        throw new Error("Invalid dock angle");
    }
    return {...shared, pose: pose};
}

function replaceBytes(buffer, field, payload) {
    return Buffer.concat([buffer.subarray(0, field.tagEnd), varint(payload.length), payload,
        buffer.subarray(field.end)]);
}

function moveDock(buffer, dxMM, dyMM, rotation = 0) {
    const source = parse(buffer);
    if (!Number.isSafeInteger(dxMM) || !Number.isSafeInteger(dyMM)) {
        throw new Error("Dock displacement must be whole millimetres");
    }
    if (!Number.isFinite(rotation) || Math.abs(rotation) > 180) {
        throw new Error("Dock rotation must be between -180 and 180 degrees");
    }
    if (dxMM === 0 && dyMM === 0 && rotation === 0) {
        return Buffer.from(buffer);
    }
    const x = source.pose.x + dxMM;
    const y = source.pose.y + dyMM;
    // Signedness is unresolved outside this positive, common representable range.
    if ([source.pose.x, source.pose.y, x, y].some(n => n < 0 || n > 25600)) {
        throw new Error("Dock position is outside the currently supported coordinate range");
    }
    const payload = Buffer.from(source.payload);
    payload.writeUInt16LE(x, 0x10);
    payload.writeUInt16LE(y, 0x12);
    if (rotation !== 0) {
        // Positive UI rotation is clockwise on the map. Persistence uses Y-up radians.
        const angle = source.pose.angle - rotation * Math.PI / 180;
        payload.writeFloatLE(Math.atan2(Math.sin(angle), Math.cos(angle)), 0x14);
    }
    if (payload.equals(source.payload)) {
        return Buffer.from(buffer);
    }
    const inner = replaceBytes(source.innerBuffer, source.stream, zlib.deflateSync(payload, {level: 6}));
    const result = replaceBytes(buffer, source.outer, inner);
    const check = parse(result);
    if (!check.payload.equals(payload)) {
        throw new Error("Dock candidate validation failed");
    }
    return result;
}

module.exports = {parse: parse, moveDock: moveDock};
