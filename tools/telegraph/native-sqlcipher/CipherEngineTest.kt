package com.portava.telegraph.validation
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
@RunWith(AndroidJUnit4::class)
class CipherEngineTest {
  private external fun roundTrip(path: String): String
  @Test fun compiledEngineEncryptsRejectsWrongKeyAndRecoversAfterReopen() {
    System.loadLibrary("portava-sqlcipher-smoke")
    val path = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir,"synthetic-telegraph-cipher.db")
    val result = roundTrip(path.absolutePath)
    assertTrue(result, result.startsWith("PASS SQLCipher "))
  }
}
