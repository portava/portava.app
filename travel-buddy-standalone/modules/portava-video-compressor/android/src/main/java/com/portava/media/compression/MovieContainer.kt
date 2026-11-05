package com.portava.media.compression

import java.io.File
import java.io.RandomAccessFile

/** Refuse external MOV references and transforms that platform rotation cannot represent. */
internal fun validateSelfContainedMovie(file: File) {
  RandomAccessFile(file, "r").use { input ->
    var boxes = 0
    var movie = false
    fun unsigned(): Long = input.readInt().toLong() and 0xffffffffL
    fun walk(start: Long, end: Long, depth: Int, dataReferences: Boolean = false) {
      require(depth <= 10) { "container nesting limit" }
      var at = start
      while (at < end) {
        require(++boxes <= 20_000 && end - at >= 8) { "invalid container bounds" }
        input.seek(at)
        var size = unsigned()
        val typeBytes = ByteArray(4); input.readFully(typeBytes)
        val type = String(typeBytes, Charsets.US_ASCII)
        var header = 8L
        if (size == 1L) { require(end - at >= 16); size = input.readLong(); header = 16 }
        else if (size == 0L) size = end - at
        require(size >= header && size <= end - at) { "invalid container size" }
        val body = at + header
        val next = at + size
        if (dataReferences) {
          require(type == "url " && size == header + 4) { "external media reference unsupported" }
          input.seek(body)
          require(input.readInt() == 1) { "external media reference unsupported" }
        } else when (type) {
          "moov", "trak", "mdia", "minf", "dinf" -> { if (type == "moov") movie = true; walk(body, next, depth + 1) }
          "dref" -> {
            require(next - body >= 8)
            input.seek(body); require(input.readInt() == 0) { "unsupported reference table" }
            val count = unsigned()
            require(count == 1L) { "one self-contained reference required" }
            walk(body + 8, next, depth + 1, true)
            require(next - body == 20L) { "invalid reference count" }
          }
          "tkhd" -> {
            input.seek(body)
            val version = input.readUnsignedByte()
            require(version in 0..1) { "unsupported track header" }
            val matrix = body + if (version == 0) 40 else 52
            require(matrix + 36 <= next) { "incomplete track matrix" }
            input.seek(matrix)
            val values = IntArray(9) { input.readInt() }
            val rotations = listOf(listOf(65536, 0, 0, 65536), listOf(0, 65536, -65536, 0),
              listOf(-65536, 0, 0, -65536), listOf(0, -65536, 65536, 0))
            require(listOf(values[0], values[1], values[3], values[4]) in rotations
              && values[2] == 0 && values[5] == 0 && values[8] == 1073741824) { "unsupported track transform" }
          }
        }
        at = next
      }
    }
    walk(0, input.length(), 0)
    require(movie) { "movie header missing" }
  }
}
