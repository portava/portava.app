Pod::Spec.new do |spec|
  spec.name = 'PortavaVideoCompressor'
  spec.version = '0.1.0'
  spec.summary = 'Private local iOS video compression'
  spec.description = 'AVFoundation implementation of the PortavaVideoCompressor contract.'
  spec.author = 'Portava'
  spec.homepage = 'https://portava.com'
  spec.platforms = { :ios => '15.1' }
  spec.source = { :path => '.' }
  spec.static_framework = true
  spec.swift_version = '5.9'
  spec.dependency 'ExpoModulesCore'
  spec.frameworks = 'AVFoundation', 'CoreMedia', 'CoreVideo', 'VideoToolbox'
  spec.source_files = '*.swift'
  spec.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
