import * as rd from "./rdecimal"
describe("decimal 2", () => {
  it("serializes & deserializes", () => {
    {
      const buf = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
      const d = rd.RustDecimal.deserialize(new Uint8Array(buf))
      expect(d.toDecimalString()).toEqual("0e-0")
    }

    {
      const buf = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
      const d = rd.RustDecimal.deserialize(new Uint8Array(buf))
      expect(d.toDecimalString()).toEqual("1e-0")
    }
    {
      const buf = [0, 0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
      const d = rd.RustDecimal.deserialize(new Uint8Array(buf))
      expect(d.toDecimalString()).toEqual("12e-0")
    }

    {
      const buf = [0, 0, 7, 0, 64, 226, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]
      const d = rd.RustDecimal.deserialize(new Uint8Array(buf))
      expect(d.toDecimalString()).toEqual("123456e-7")
    }
    {
      const buf = [0, 0, 16, 0, 121, 223, 13, 134, 72, 112, 0, 0, 0, 0, 0, 0]
      const d = rd.RustDecimal.deserialize(new Uint8Array(buf))
      expect(d.toDecimalString()).toEqual("123456789012345e-16")
    }
    {
      const buf = [0, 0, 28, 0, 194, 101, 122, 170, 1, 47, 245, 129, 63, 148, 101, 22]
      const d = rd.RustDecimal.deserialize(new Uint8Array(buf))
      expect(d.toDecimalString()).toEqual("6931471805599453094172321218e-28")
    }
  })

  describe("fromString", () => {
    it("converts string to RustDecimal", () => {
      const d1 = rd.RustDecimal.fromString("123.456")
      expect(d1.toFloat()).toBeCloseTo(123.456)
      expect(d1.toDecimalString()).toMatch(/^12345600000000000000000e-20$/)

      const d2 = rd.RustDecimal.fromString("0")
      expect(d2.toFloat()).toBe(0)

      const d3 = rd.RustDecimal.fromString("-99.99")
      expect(d3.toFloat()).toBeCloseTo(-99.99)
      expect(d3.getSign()).toBe(1)

      const d4 = rd.RustDecimal.fromString("1000000")
      expect(d4.toFloat()).toBe(1000000)

      const d5 = rd.RustDecimal.fromString("0.000001")
      expect(d5.toFloat()).toBeCloseTo(0.000001)

      const d6 = rd.RustDecimal.fromString("123456789.012345")
      expect(d6.toFloat()).toBeCloseTo(123456789.012345)
    })

    it("handles edge cases", () => {
      const d1 = rd.RustDecimal.fromString("0.0")
      expect(d1.toFloat()).toBe(0)

      const d2 = rd.RustDecimal.fromString("-0")
      expect(d2.toFloat()).toBe(-0)

      const d3 = rd.RustDecimal.fromString("1e6")
      expect(d3.toFloat()).toBe(1000000)

      const d4 = rd.RustDecimal.fromString("1.23e-4")
      expect(d4.toFloat()).toBeCloseTo(0.000123)
    })

    it("serializes and deserializes correctly", () => {
      const original = "123.456789"
      const d = rd.RustDecimal.fromString(original)
      const serialized = d.serialize()
      const deserialized = rd.RustDecimal.deserialize(serialized)
      expect(deserialized.toFloat()).toBeCloseTo(parseFloat(original))
    })
  })
})
