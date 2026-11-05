Pod::Spec.new do |spec|
  spec.name = 'PortavaOnDeviceSpeech'
  spec.version = '1.0.0'
  spec.summary = 'Foreground on-device-only speech input'
  spec.description = 'Bounded selected-locale dictation with no cloud fallback or retained audio.'
  spec.author = 'Portava'
  spec.homepage = 'https://portava.com'
  spec.platforms = { :ios => '15.1' }
  spec.source = { :path => '.' }
  spec.static_framework = true
  spec.swift_version = '5.9'
  spec.dependency 'ExpoModulesCore'
  spec.frameworks = 'Speech', 'AVFoundation'
  spec.source_files = '*.swift'
  spec.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
