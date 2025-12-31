import Decimal from "decimal.js"

export type AnchorRDecimal = { 0: number[] }

export class RustDecimal {
  // Internal representation of the Decimal
  private flags: number
  private hi: number
  private lo: number
  private mid: number

  constructor(flags: number, hi: number, lo: number, mid: number) {
    this.flags = flags
    this.hi = hi
    this.lo = lo
    this.mid = mid
  }

  static fromAnchorizedRDecimal(r: AnchorRDecimal): RustDecimal {
    const buffer = new Uint8Array(r[0])
    return RustDecimal.deserialize(buffer)
  }

  static deserializeFromAnchorized(r: number[]): RustDecimal {
    const buffer = new Uint8Array(r)
    return RustDecimal.deserialize(buffer)
  }

  // Deserialize function
  static deserialize(buffer: Uint8Array): RustDecimal {
    // Assuming the buffer is 16 bytes long (4 bytes for each field)
    if (buffer.length !== 16) {
      throw new Error("Invalid buffer length")
    }

    // Extract fields from the buffer
    const flags = new DataView(buffer.buffer).getUint32(0, true)
    const lo = new DataView(buffer.buffer).getUint32(4, true)
    const mid = new DataView(buffer.buffer).getUint32(8, true)
    const hi = new DataView(buffer.buffer).getUint32(12, true)

    return new RustDecimal(flags, hi, lo, mid)
  }

  static fromFloat(value: number): RustDecimal {
    return RustDecimal.fromDecimalJs(new Decimal(value))
  }

  static fromString(value: string): RustDecimal {
    return RustDecimal.fromDecimalJs(new Decimal(value))
  }

  static fromDecimalJs(value: Decimal): RustDecimal {
    // Get the sign
    const isNegative = value.isNegative()

    // Get the absolute value and convert to string
    const absValue = value.abs().toFixed(20)

    // Split into integer and fractional parts
    const [intPart, fracPart = ""] = absValue.split(".")

    // Calculate scale (number of decimal places)
    const scale = fracPart.length

    // Combine integer and fractional parts, removing the decimal point
    const combinedValue = BigInt(intPart + fracPart)

    // Calculate flags
    const flags = (scale << 16) | (isNegative ? 1 << 31 : 0)

    // Split the combined value into hi, mid, and lo
    const hi = Number((combinedValue >> 64n) & 0xffffffffn)
    const mid = Number((combinedValue >> 32n) & 0xffffffffn)
    const lo = Number(combinedValue & 0xffffffffn)

    return new RustDecimal(flags, hi, lo, mid)
  }

  serialize(): Uint8Array {
    const buffer = new ArrayBuffer(16)
    const view = new DataView(buffer)

    // Write flags (4 bytes)
    view.setUint32(0, this.flags, true)

    // Write lo (4 bytes)
    view.setUint32(4, this.lo, true)

    // Write mid (4 bytes)
    view.setUint32(8, this.mid, true)

    // Write hi (4 bytes)
    view.setUint32(12, this.hi, true)

    return new Uint8Array(buffer)
  }

  serializeToAnchorized(): number[] {
    return Array.from(this.serialize())
  }

  // Method to get the value of 'e' from flags
  getScale(): number {
    return (this.flags >> 16) & 0xff // Bits 16-23
  }

  getSign(): number {
    return (this.flags >> 31) & 0x1 // Bit 31
  }

  // Combine hi, lo, and mid to form the 96-bit integer
  getValue(): bigint {
    // Construct the 96-bit integer from the fields
    const combined = (BigInt(this.hi) << 64n) | (BigInt(this.mid) << 32n) | BigInt(this.lo)
    return combined
  }

  // Get the decimal representation
  toDecimalString(): string {
    const scale = this.getScale()
    const sign = this.getSign() === 1 ? "-" : ""
    const value = this.getValue()
    return `${sign}${value.toString()}e-${scale}`
  }

  /** Convert to float */
  toFloat(): number {
    return parseFloat(this.toDecimalString())
  }

  /** Convert to Decimal.js */
  toDecimalJs(): Decimal {
    return new Decimal(this.toDecimalString())
  }
}
