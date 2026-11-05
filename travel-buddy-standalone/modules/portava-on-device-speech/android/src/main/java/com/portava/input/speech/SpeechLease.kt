package com.portava.input.speech

/** No approximate locale match: an installed en-US model is not evidence for fr-FR. */
internal data class SpeechLease(val requestId: String, val language: String, val wallEnd: Long, val monotonicEnd: Long) {
  fun live(wall: Long, monotonic: Long): Boolean = wall < wallEnd && monotonic < monotonicEnd
  companion object {
    fun validLanguage(value: String) = value.matches(Regex("^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,4}$"))
    fun installed(language: String, models: List<String>) = validLanguage(language) && models.any { it.replace('_', '-').equals(language, ignoreCase = true) }
    fun parse(id: String, language: String, end: Double, wall: Long, monotonic: Long): SpeechLease {
      require(id.matches(Regex("^[A-Za-z0-9-]{1,64}$")) && validLanguage(language))
      require(end.isFinite() && end > wall && end - wall <= 60_000)
      return SpeechLease(id, language, end.toLong(), monotonic + (end - wall).toLong())
    }
  }
}
