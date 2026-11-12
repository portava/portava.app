package com.portava.media.upload

import android.app.NotificationManager
import android.content.Intent
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class UploadServiceTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val context = instrumentation.targetContext
  private lateinit var server: MockWebServer
  private lateinit var engine: UploadEngine
  private lateinit var file: File
  @Before fun setup() {
    context.getSharedPreferences("portava_upload_cancellations", 0).edit().clear().commit()
    val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
    val serverTls = HandshakeCertificates.Builder().heldCertificate(certificate).build()
    val clientTls = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
    server = MockWebServer().apply { useHttps(serverTls.sslSocketFactory(), false); start() }
    engine = UploadEngine(listOf(context.cacheDir, context.filesDir), OkHttpClient.Builder().sslSocketFactory(clientTls.sslSocketFactory(), clientTls.trustManager).build())
    UploadRuntime.javaClass.getDeclaredField("instance").apply { isAccessible = true }.set(UploadRuntime, engine)
    file = File(context.cacheDir, "synthetic-upload.bin").apply { writeBytes(ByteArray(2 * 1024 * 1024) { (it % 251).toByte() }) }
    engine.bind("synthetic-owner", server.url("/").toString())
    context.startActivity(context.packageManager.getLaunchIntentForPackage(context.packageName)!!.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    Thread.sleep(500)
  }
  @After fun teardown() {
    engine.cancelAll()
    context.stopService(Intent(context, UploadService::class.java))
    Thread.sleep(250)
    server.shutdown()
    file.delete()
  }
  private fun enqueue(id: String = "part", progress: (UploadProgress) -> Unit = {}, onResult: (Result<UploadResult>) -> Unit) {
    engine.enqueue(id, "synthetic-owner", server.url("/storage/v1/object/upload/sign/fixture/part?token=synthetic").toString(), file.toURI().toString(), "application/octet-stream", progress, onResult)
    context.startForegroundService(Intent(context, UploadService::class.java))
  }
  @Test fun realTlsPutCompletesInBackgroundWithVisibleServiceAndExactBytes() {
    file.writeBytes(ByteArray(16 * 1024 * 1024) { (it % 251).toByte() })
    server.enqueue(MockResponse().setResponseCode(200).setBody("ok").throttleBody(32 * 1024, 20, TimeUnit.MILLISECONDS))
    val done = CountDownLatch(1)
    var result: Result<UploadResult>? = null
    val sent = java.util.concurrent.atomic.AtomicLong()
    enqueue(progress = { sent.set(it.sent) }) { result = it; done.countDown() }
    Thread.sleep(300)
    val beforeHome = sent.get()
    assertTrue("bytes remain when leaving the app", beforeHome < file.length())
    instrumentation.uiAutomation.executeShellCommand("input keyevent KEYCODE_HOME").close()
    assertTrue("service still runs after Home", UploadRuntime.running)
    assertTrue("foreground notification posted", context.getSystemService(NotificationManager::class.java).activeNotifications.any { it.id == 20741 })
    assertTrue(done.await(30, TimeUnit.SECONDS))
    assertTrue("bytes transferred after leaving the app", sent.get() > beforeHome)
    assertEquals(200, result!!.getOrThrow().status)
    val request = server.takeRequest(5, TimeUnit.SECONDS)!!
    assertEquals("PUT", request.method)
    assertArrayEquals(file.readBytes(), request.body.readByteArray())
    assertEquals("true", request.getHeader("x-upsert"))
  }
  @Test fun ownerReplacementCancelsPendingResponseAndRejectsOldWork() {
    server.enqueue(MockResponse().setResponseCode(200).setHeadersDelay(3, TimeUnit.SECONDS))
    val done = CountDownLatch(1)
    var failed = false
    enqueue { failed = it.isFailure; done.countDown() }
    assertNotNull(server.takeRequest(5, TimeUnit.SECONDS))
    engine.bind("new-owner", server.url("/").toString())
    assertTrue(done.await(3, TimeUnit.SECONDS)); assertTrue(failed)
    assertEquals(0, engine.snapshot().first)
    assertTrue(runCatching { engine.enqueue("old", "synthetic-owner", server.url("/storage/v1/object/upload/sign/f/p?token=t").toString(), file.toURI().toString(), "application/octet-stream", {}, {}) }.isFailure)
  }
  @Test fun redirectIsReturnedWithoutLeakingBytesToTarget() {
    server.enqueue(MockResponse().setResponseCode(307).addHeader("Location", server.url("/not-authorized")))
    val done = CountDownLatch(1)
    var status = 0
    enqueue { status = it.getOrThrow().status; done.countDown() }
    assertTrue(done.await(10, TimeUnit.SECONDS)); assertEquals(307, status)
    assertEquals(1, server.requestCount)
  }
  @Test fun notificationCancelStopsNetworkAndService() {
    server.enqueue(MockResponse().setResponseCode(200).setHeadersDelay(3, TimeUnit.SECONDS))
    val done = CountDownLatch(1)
    var failed = false
    enqueue { failed = it.isFailure; done.countDown() }
    assertNotNull(server.takeRequest(5, TimeUnit.SECONDS))
    val notification = context.getSystemService(NotificationManager::class.java).activeNotifications.first { it.id == 20741 }.notification
    notification.actions.first().actionIntent.send()
    assertTrue(done.await(3, TimeUnit.SECONDS)); assertTrue(failed)
    Thread.sleep(300)
    assertFalse(UploadRuntime.running)
    assertTrue("notification cancellation survives JS/process replacement", UploadRuntime.wasCancelled(context, "synthetic-owner"))
  }
  @Test fun queueBoundAndCancellationReleaseAllPendingWork() {
    var cancelled = 0
    repeat(UploadPolicy.MAX_TASKS) { index ->
      engine.enqueue("part_$index", "synthetic-owner", server.url("/storage/v1/object/upload/sign/f/p?token=t").toString(), file.toURI().toString(), "application/octet-stream", {}, { if (it.isFailure) cancelled++ })
    }
    assertTrue(runCatching { engine.enqueue("overflow", "synthetic-owner", server.url("/storage/v1/object/upload/sign/f/p?token=t").toString(), file.toURI().toString(), "application/octet-stream", {}, {}) }.isFailure)
    engine.clear("different-owner")
    assertEquals(UploadPolicy.MAX_TASKS, engine.snapshot().first)
    engine.clear("synthetic-owner")
    assertEquals(UploadPolicy.MAX_TASKS, cancelled)
    assertEquals(0, engine.snapshot().first)
    assertEquals(0, server.requestCount)
  }

}
