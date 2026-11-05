package com.portava.media.upload

import java.io.File
import java.io.IOException
import java.net.URI
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink

/** No credentials or signed URLs are persisted. The JS durable queue owns recovery. */
internal object UploadPolicy {
  const val MAX_TASKS = 32
  const val MAX_FILE_BYTES = 100L * 1024 * 1024
  const val MAX_QUEUED_BYTES = 256L * 1024 * 1024
  fun origin(raw: String): HttpUrl {
    val url = raw.toHttpUrl()
    require(url.isHttps && url.username.isEmpty() && url.password.isEmpty() && url.fragment == null
      && url.query == null && url.encodedPath == "/") { "Invalid upload origin" }
    return url
  }
  fun destination(raw: String, origin: HttpUrl): HttpUrl {
    val url = raw.toHttpUrl()
    require(url.isHttps && url.host == origin.host && url.port == origin.port
      && url.username.isEmpty() && url.password.isEmpty() && url.fragment == null
      && url.encodedPath.startsWith("/storage/v1/object/upload/sign/")
      && !url.queryParameter("token").isNullOrBlank()) { "Untrusted upload destination" }
    return url
  }
  fun file(raw: String, roots: List<File>): File {
    val uri = URI(raw)
    require(uri.scheme == "file" && uri.rawAuthority.isNullOrEmpty() && uri.query == null && uri.fragment == null) { "Invalid upload file" }
    val file = File(uri).canonicalFile
    require(roots.any { file.path.startsWith(it.canonicalPath + File.separator) }) { "Upload file is outside app storage" }
    require(file.isFile && file.canRead() && file.length() in 1..MAX_FILE_BYTES) { "Invalid upload file size" }
    return file
  }
}

internal data class UploadResult(val status: Int, val retryAfter: String?)
internal data class UploadProgress(val id: String, val sent: Long, val total: Long)
internal class UploadEngine(private val roots: List<File>, client: OkHttpClient? = null) {
  private val lock = Any()
  private val http = (client ?: OkHttpClient()).newBuilder()
    .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
    .connectTimeout(30, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
    .writeTimeout(30, TimeUnit.SECONDS).callTimeout(15, TimeUnit.MINUTES).build()
  private val workers = ThreadPoolExecutor(3, 3, 0, TimeUnit.SECONDS, LinkedBlockingQueue<Runnable>(UploadPolicy.MAX_TASKS))
  private var owner: String? = null
  private var origin: HttpUrl? = null
  private val tasks = linkedMapOf<String, Task>()
  private data class Task(val id: String, val owner: String, val file: File, val size: Long,
    val url: HttpUrl, val mime: String, val progress: (UploadProgress) -> Unit,
    val completion: (Result<UploadResult>) -> Unit, var started: Boolean = false,
    var call: Call? = null, var sent: Long = 0, var future: Future<*>? = null)
  var changed: (() -> Unit)? = null
  fun bind(key: String, rawOrigin: String) {
    require(key.length in 1..200) { "Invalid upload owner" }
    val destination = UploadPolicy.origin(rawOrigin)
    synchronized(lock) {
      if (owner == key && origin == destination) return
      cancelAllLocked()
      owner = key
      origin = destination
    }
    changed?.invoke()
  }
  fun ownerKey(): String? = synchronized(lock) { owner }
  fun clear(key: String) {
    synchronized(lock) {
      if (owner != key) return
      owner = null
      origin = null
      cancelAllLocked()
    }
    changed?.invoke()
  }
  fun enqueue(id: String, key: String, url: String, uri: String, mime: String,
    progress: (UploadProgress) -> Unit, completion: (Result<UploadResult>) -> Unit) {
    require(id.matches(Regex("[A-Za-z0-9_-]{1,100}"))) { "Invalid upload id" }
    require(mime.length <= 100 && mime.toMediaTypeOrNull() != null) { "Invalid media type" }
    val file = UploadPolicy.file(uri, roots)
    synchronized(lock) {
      require(owner == key && origin != null) { "Upload session changed" }
      require(!tasks.containsKey(id) && tasks.size < UploadPolicy.MAX_TASKS
        && tasks.values.sumOf { it.size } + file.length() <= UploadPolicy.MAX_QUEUED_BYTES) { "Upload queue capacity exceeded" }
      tasks[id] = Task(id, key, file, file.length(), UploadPolicy.destination(url, origin!!), mime, progress, completion)
    }
  }
  /** Only called after the service is visibly in the foreground. */
  fun start() {
    synchronized(lock) {
      tasks.values.filter { !it.started }.forEach { task ->
        task.started = true
        task.future = workers.submit { run(task) }
      }
    }
    changed?.invoke()
  }
  fun cancel(id: String, key: String) {
    synchronized(lock) {
      tasks[id]?.takeIf { it.owner == key }?.let { removeCancelled(it) }
    }
    changed?.invoke()
  }
  fun cancelAll() {
    synchronized(lock) { cancelAllLocked() }
    changed?.invoke()
  }
  private fun cancelAllLocked() { tasks.values.toList().forEach(::removeCancelled) }
  private fun removeCancelled(task: Task) {
    tasks.remove(task.id)
    task.call?.cancel()
    task.future?.cancel(true)
    workers.purge()
    task.completion(Result.failure(IOException("Upload cancelled")))
  }
  fun snapshot(): Pair<Int, Int> = synchronized(lock) {
    val total = tasks.values.sumOf { it.size }
    tasks.size to if (total == 0L) 0 else ((100L * tasks.values.sumOf { it.sent }) / total).toInt()
  }
  private fun run(task: Task) {
    val result = runCatching {
      val body = object : RequestBody() {
        override fun contentType() = task.mime.toMediaTypeOrNull()
        override fun contentLength() = task.size
        override fun writeTo(sink: BufferedSink) {
          if (task.file.length() != task.size) throw IOException("Upload file changed")
          task.file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            var sent = 0L
            var lastReport = 0L
            while (sent < task.size) {
              synchronized(lock) { if (tasks[task.id] !== task || owner != task.owner) throw IOException("Upload cancelled") }
              val count = input.read(buffer, 0, minOf(buffer.size.toLong(), task.size - sent).toInt())
              if (count < 0) throw IOException("Upload file ended early")
              sink.write(buffer, 0, count)
              sent += count
              val now = System.nanoTime()
              if (sent == task.size || now - lastReport > 250_000_000) {
                lastReport = now
                synchronized(lock) {
                  if (tasks[task.id] === task) {
                    task.sent = sent
                    task.progress(UploadProgress(task.id, sent, task.size))
                  }
                }
                changed?.invoke()
              }
            }
          }
        }
      }
      val call = http.newCall(Request.Builder().url(task.url).put(body).header("x-upsert", "true").build())
      synchronized(lock) {
        if (tasks[task.id] !== task || owner != task.owner) throw IOException("Upload cancelled")
        task.call = call
      }
      call.execute().use { UploadResult(it.code, it.header("retry-after")) }
    }
    synchronized(lock) {
      if (tasks[task.id] === task) {
        tasks.remove(task.id)
        // Do not forward exception messages: an HTTP exception can contain a signed URL.
        task.completion(result.fold({ Result.success(it) }, { Result.failure(IOException("Upload interrupted")) }))
      }
    }
    changed?.invoke()
  }
}
