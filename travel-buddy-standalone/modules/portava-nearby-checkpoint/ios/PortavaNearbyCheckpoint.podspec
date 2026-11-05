Pod::Spec.new do |spec|
  spec.name = 'PortavaNearbyCheckpoint'
  spec.version = '1.0.0'
  spec.summary = 'Foreground trip-scoped nearby checkpoints'
  spec.description = 'Bounded Bluetooth GATT exchange of rotating opaque checkpoint tokens.'
  spec.author = 'Portava'
  spec.homepage = 'https://portava.com'
  spec.platforms = { :ios => '15.1' }
  spec.source = { :path => '.' }
  spec.static_framework = true
  spec.swift_version = '5.9'
  spec.dependency 'ExpoModulesCore'
  spec.frameworks = 'CoreBluetooth'
  spec.source_files = '*.swift'
  spec.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
