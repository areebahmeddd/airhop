Pod::Spec.new do |s|
  s.name             = 'IPtProxy'
  s.version          = '5.8.1'
  s.summary          = "Airhop's pluggable transports"
  s.description      = <<~DESC
    Binary xcframework wrapping Lyrebird (obfs4) and Snowflake as a library.

    Built from pinned sources by native/iptproxy/build-apple.sh, not taken from
    upstream, which ships a prebuilt binary. Everything Airhop ships is compiled
    here and hashed in vendor.lock.json.

    Arti would normally run these as child processes, which iOS forbids. They
    run in-process instead and expose a SOCKS5 listener each, which
    AirhopIPtProxy.swift starts and AirhopTorManager.swift hands to Arti.
  DESC
  s.homepage         = 'https://github.com/tladesignz/IPtProxy'
  s.license          = { :type => 'MIT' }
  s.author           = { 'Benjamin Erhart' => 'berhart@netzarchitekten.com' }
  s.platform         = :ios, '16.4'

  s.source             = { :path => '.' }
  s.vendored_frameworks = 'Frameworks/IPtProxy.xcframework'

  # Go's runtime resolver needs these; the framework itself declares no others.
  s.libraries = 'resolv'
end
