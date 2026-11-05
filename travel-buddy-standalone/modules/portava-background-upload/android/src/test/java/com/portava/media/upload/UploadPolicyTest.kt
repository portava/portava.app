package com.portava.media.upload
import java.io.File
import org.junit.Assert.*
import org.junit.Test

class UploadPolicyTest {
  private val origin = UploadPolicy.origin("https://storage.example")
  private fun rejects(block: () -> Unit) { assertTrue(runCatching(block).isFailure) }
  @Test fun signedDestinationRequiresExactTlsOrigin() {
    assertEquals("storage.example", UploadPolicy.destination("https://storage.example/storage/v1/object/upload/sign/bucket/file?token=synthetic", origin).host)
    listOf("http://storage.example/storage/v1/object/upload/sign/b/f?token=t", "https://other.example/storage/v1/object/upload/sign/b/f?token=t",
      "https://user:secret@storage.example/storage/v1/object/upload/sign/b/f?token=t", "https://storage.example:444/storage/v1/object/upload/sign/b/f?token=t",
      "https://storage.example/storage/v1/object/upload/sign/b/f", "https://storage.example/untrusted?token=t").forEach { url -> rejects { UploadPolicy.destination(url, origin) } }
  }
  @Test fun originCannotCarryCredentialsPathOrQuery() {
    listOf("http://storage.example", "https://user@storage.example", "https://storage.example/path", "https://storage.example/?secret=x").forEach { rejects { UploadPolicy.origin(it) } }
  }
  @Test fun fileMustBeInsidePrivateRoot() {
    val root = createTempDir(prefix="upload-policy")
    try {
      val file = File(root, "part.bin").apply { writeBytes(byteArrayOf(1,2,3)) }
      assertEquals(file.canonicalFile, UploadPolicy.file(file.toURI().toString(), listOf(root)))
      rejects { UploadPolicy.file(file.toURI().toString(), listOf(File(root, "other"))) }
      rejects { UploadPolicy.file(root.toURI().toString(), listOf(root)) }
      rejects { UploadPolicy.file("content://media/1", listOf(root)) }
    } finally { root.deleteRecursively() }
  }
  @Test fun zeroAndOversizedFilesAreRejected() {
    val root = createTempDir(prefix="upload-policy")
    try {
      val file = File(root, "part.bin").apply { createNewFile() }
      rejects { UploadPolicy.file(file.toURI().toString(), listOf(root)) }
      java.io.RandomAccessFile(file, "rw").use { it.setLength(UploadPolicy.MAX_FILE_BYTES + 1) }
      rejects { UploadPolicy.file(file.toURI().toString(), listOf(root)) }
    } finally { root.deleteRecursively() }
  }
}
