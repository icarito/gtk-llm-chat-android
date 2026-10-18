Pod::Spec.new do |s|
  s.name           = 'XmppForeground'
  s.version        = '1.0.0'
  s.summary        = 'No-op stub: foreground service is Android-only'
  s.license        = 'MIT'
  s.author         = 'fuentelibre'
  s.homepage       = 'https://fuentelibre.org'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
