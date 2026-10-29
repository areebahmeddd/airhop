// AirhopWidget: the home screen widget on iOS. How many peers are in range, and
// as of when, so the mesh can be seen to be alive without opening the app.
//
// It counts nothing itself. background-notice.ts pushes a snapshot through
// AirhopAppModule into the App Group, and asks WidgetKit to reload, so this
// and the Mesh tab cannot disagree. MeshWidgetState.swift decides what a
// snapshot means; Android draws the same states from the same rules.
//
// Drawn to match the Android widget and the app: theme.ts colours, the pixel
// mark, the count as the app draws a display figure. The extension targets
// iOS 17, the first with containerBackground and disfavoredLocations; on iOS 16
// the app runs and the widget is simply not offered.
import SwiftUI
import UIKit
import WidgetKit

// Not named AirhopWidget, which is the module's own name.
@main
struct MeshWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: MeshWidgetStore.kind, provider: MeshTimeline()) { entry in
      MeshWidgetView(entry: entry)
    }
    .configurationDisplayName("widget_label")
    .description("widget_description")
    .supportedFamilies([.systemSmall])
    // Home screen only. StandBy and the iPad lock screen show home screen
    // widgets to whoever holds the device, so the widget is kept off both, and
    // privacySensitive below redacts the reading where iOS shows it anyway.
    .disfavoredLocations([.standBy, .lockScreen], for: [.systemSmall])
  }
}

struct MeshEntry: TimelineEntry {
  let date: Date
  let state: MeshWidgetState
}

struct MeshTimeline: TimelineProvider {
  // The gallery and the placeholder show no count, so no invented one.
  func placeholder(in context: Context) -> MeshEntry {
    MeshEntry(date: Date(), state: .unset)
  }

  func getSnapshot(in context: Context, completion: @escaping (MeshEntry) -> Void) {
    completion(context.isPreview ? placeholder(in: context) : entries(now: Date())[0])
  }

  // `.never`: the app reloads on every reading it pushes, and the one change
  // that happens with no push, a reading going stale, is its own entry.
  func getTimeline(in context: Context, completion: @escaping (Timeline<MeshEntry>) -> Void) {
    completion(Timeline(entries: entries(now: Date()), policy: .never))
  }

  private func entries(now: Date) -> [MeshEntry] {
    let snapshot = UserDefaults(suiteName: MeshWidgetStore.suiteName).flatMap {
      MeshSnapshot.read(from: $0)
    }
    let state = MeshWidgetState(snapshot, nowMs: now.milliseconds, bootMs: bootMilliseconds())
    var entries = [MeshEntry(date: now, state: state)]
    if let staleAtMs = MeshWidgetState.staleAtMs(for: snapshot, state: state) {
      entries.append(MeshEntry(date: Date(milliseconds: staleAtMs), state: .stale))
    }
    return entries
  }

  // When this boot began, on the wall clock. kern.boottime rather than
  // systemUptime, which stops while the phone sleeps and would place the boot
  // later than it was. Zero when unreadable, which no reading predates.
  private func bootMilliseconds() -> Int64 {
    var boot = timeval()
    var size = MemoryLayout<timeval>.size
    guard sysctlbyname("kern.boottime", &boot, &size, nil, 0) == 0 else { return 0 }
    return Int64(boot.tv_sec) * 1000 + Int64(boot.tv_usec) / 1000
  }
}

struct MeshWidgetView: View {
  let entry: MeshEntry

  var body: some View {
    let lines = MeshWidgetLines(entry.state, copy: BundleCopy())
    VStack(alignment: .leading, spacing: 0) {
      PixelMark()
        .fill(Palette.ink)
        .frame(width: 22, height: 12)
        .accessibilityHidden(true)
      Spacer(minLength: 8)
      if let count = lines.count {
        // A display figure, as the wallet balance is drawn: bold, slight
        // negative tracking, digits that hold their width as the count moves.
        // A fixed size, so it is the captions that grow under a large Dynamic
        // Type size, and it shrinks before it clips beside them. The
        // accent group, so a tinted Home Screen paints the number in the
        // chosen tint and everything else white.
        Text(count)
          .font(.system(size: 30, weight: .bold))
          .monospacedDigit()
          .tracking(-0.6)
          .lineLimit(1)
          .minimumScaleFactor(0.6)
          .foregroundStyle(Palette.ink)
          .widgetAccentable()
          .privacySensitive()
        Text(lines.caption)
          .font(.footnote)
          .foregroundStyle(Palette.secondary)
          .lineLimit(2)
          .padding(.top, 4)
      } else {
        // With no count, the message is the content, so it takes the ink and
        // the size the caption only supports.
        Text(lines.caption)
          .font(.subheadline)
          .foregroundStyle(Palette.ink)
          .lineLimit(3)
      }
      // A line of its own and the full width, so neither a long caption nor a
      // narrow widget can ellipsize the time away.
      if let asOf = lines.asOf {
        Text(asOf)
          .font(.caption2)
          .monospacedDigit()
          .foregroundStyle(Palette.secondary)
          .lineLimit(1)
          .padding(.top, 2)
          .privacySensitive()
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    // One element, read in view order: "3, peers in range, as of 14:05".
    .accessibilityElement(children: .combine)
    .containerBackground(Palette.surface, for: .widget)
    // app.tsx answers it by switching to the Mesh tab, the screen this
    // summarises.
    .widgetURL(URL(string: "airhop://mesh"))
  }
}

// The extension's own Localizable tables, picked by the system language like
// every iOS string the app does not draw itself.
private struct BundleCopy: MeshWidgetCopy {
  func asOf(atMs: Int64) -> String {
    String.localizedStringWithFormat(
      NSLocalizedString("widget_as_of", comment: ""),
      time(Date(milliseconds: atMs))
    )
  }

  // The count picks the form and is drawn on its own line above.
  func inRange(count: Int) -> String {
    String.localizedStringWithFormat(NSLocalizedString("widget_in_range", comment: ""), count)
  }

  func nobody() -> String {
    NSLocalizedString("widget_nobody", comment: "")
  }

  func paused() -> String {
    NSLocalizedString("widget_paused", comment: "")
  }

  func unset() -> String {
    NSLocalizedString("widget_unset", comment: "")
  }

  func stale() -> String {
    NSLocalizedString("widget_stale", comment: "")
  }

  func bluetoothOff() -> String {
    NSLocalizedString("mesh_bluetooth_off", comment: "")
  }

  // Latin digits, as the app writes them, where Arabic, Persian, Bengali,
  // Burmese and Nepali default to their own. Components keep the rest of the
  // user's locale, the 12 or 24-hour choice included.
  private func time(_ date: Date) -> String {
    var components = Locale.Components(locale: .current)
    components.numberingSystem = Locale.NumberingSystem("latn")
    let style = Date.FormatStyle(date: .omitted, time: .shortened)
      .locale(Locale(components: components))
    return date.formatted(style)
  }
}

// The theme.ts tokens the Android widget also draws with: surface, textPrimary
// and textSecondary, light and dark.
private enum Palette {
  static let surface = Color(light: 0xFFFFFF, dark: 0x161616)
  static let ink = Color(light: 0x111111, dark: 0xF5F5F5)
  static let secondary = Color(light: 0x565656, dark: 0xA6A6A6)
}

extension Color {
  fileprivate init(light: UInt32, dark: UInt32) {
    self.init(
      uiColor: UIColor { traits in
        let rgb = traits.userInterfaceStyle == .dark ? dark : light
        return UIColor(
          red: CGFloat((rgb >> 16) & 0xFF) / 255,
          green: CGFloat((rgb >> 8) & 0xFF) / 255,
          blue: CGFloat(rgb & 0xFF) / 255,
          alpha: 1
        )
      }
    )
  }
}

// The Airhop mark, one rectangle per cell of its 11 by 6 grid, read from
// landing/public/brand/airhop-icon.svg as the Android drawables are. Drawn
// rather than shipped as an asset, so it stays exact at any scale and needs no
// asset catalog in the extension. Mirror-symmetric, so right-to-left needs no
// flipped copy.
private struct PixelMark: Shape {
  private static let rows = [
    "##.......##",
    ".##.....##.",
    "..##.#.##..",
    "...#####...",
    "....###....",
    ".....#.....",
  ]

  func path(in rect: CGRect) -> Path {
    let cellWidth = rect.width / 11
    let cellHeight = rect.height / 6
    var path = Path()
    for (y, row) in Self.rows.enumerated() {
      for (x, cell) in row.enumerated() where cell == "#" {
        path.addRect(
          CGRect(
            x: rect.minX + CGFloat(x) * cellWidth,
            y: rect.minY + CGFloat(y) * cellHeight,
            width: cellWidth,
            height: cellHeight
          )
        )
      }
    }
    return path
  }
}

extension Date {
  fileprivate var milliseconds: Int64 { Int64(timeIntervalSince1970 * 1000) }

  fileprivate init(milliseconds: Int64) {
    self.init(timeIntervalSince1970: TimeInterval(milliseconds) / 1000)
  }
}
