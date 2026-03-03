# Platform Data APIs — Research Notes

Reference for OS-level APIs that can feed the unified event stream.
Linked from [architecture.md](architecture.md).

---

## The Big Picture

Every major OS already has push-based APIs for observing changes to files,
contacts, calendars, photos, and more. **Nobody has unified them into a
single event stream with a sync layer.** The closest attempts:

- **Zeitgeist** (Linux) — logged user activity across apps via D-Bus.
  Died because it was GNOME-only, had no sync layer, and stalled in 2015.
- **Android ContentObserver** — unified *pattern* (same API for any data
  type), but no cross-platform reach and no sync.
- **Apple Spotlight** — powerful file metadata indexing with live queries,
  but scoped to files and macOS only.
- **Nepomuk** — defined the semantic desktop ontologies that GNOME Tracker
  still uses, but never achieved cross-desktop adoption.

We're building the missing piece: a cross-platform event log + sync layer
that any OS-level observer can feed into.

---

## Linux

### inotify

Kernel subsystem for filesystem change monitoring (since Linux 2.6.13).

| Property | Value |
|----------|-------|
| API | `inotify_init()`, `inotify_add_watch()`, read from fd |
| Events | `IN_CREATE`, `IN_DELETE`, `IN_MODIFY`, `IN_MOVED_FROM/TO`, `IN_ATTRIB`, `IN_CLOSE_WRITE`, `IN_OPEN` |
| Push/Poll | Push (fd becomes readable) |
| Recursive | No — must add watches per directory |
| Limits | `max_user_watches` default 8192 (configurable via `/proc/sys/fs/inotify/max_user_watches`) |
| Limitations | No network filesystems (NFS, CIFS). No mmap/msync changes. Event queue can overflow. No pseudo-filesystems (/proc, /sys). |
| Maturity | Very mature. Standard tool for userspace fs monitoring. |
| Rust crate | `inotify` (wraps the syscalls) or `notify` (cross-platform, uses inotify on Linux) |

### fanotify

Superset of inotify (since Linux 2.6.36/37). Key additions: whole-mount
monitoring and permission events.

| Property | Value |
|----------|-------|
| API | `fanotify_init()`, `fanotify_mark()`, read from fd |
| Whole mount | Yes — can monitor an entire mounted filesystem |
| Permission events | Can block file operations until userspace approves (`FAN_ALLOW`/`FAN_DENY`) |
| Push/Poll | Push |
| Limitations | Requires `CAP_SYS_ADMIN` for permission events. Same mmap/network limitations as inotify. |
| Maturity | Mature for system tools (antivirus, backup). Less common in regular apps. |

### D-Bus

IPC message bus. Two buses: system (hardware, system services) and session
(desktop apps, user services).

| Property | Value |
|----------|-------|
| Mechanism | Publish/subscribe signals on well-known bus names |
| Push/Poll | Push (signal-based, async) |
| Contacts/Calendar | Not directly — but EDS and Akonadi use D-Bus as transport |
| File changes | Not directly — but Tracker uses D-Bus for notifications |
| Maturity | Very mature. Core desktop infrastructure since ~2006. |
| Note | `dbus-broker` is a newer high-performance alternative to `dbus-daemon` |

### TinySPARQL + LocalSearch (fka GNOME Tracker)

File indexing and search framework. Renamed in 2024: SPARQL library →
TinySPARQL, file indexer → LocalSearch.

| Property | Value |
|----------|-------|
| Indexes | Documents, audio, video, photos, software. Uses Nepomuk ontology. |
| Named graphs | `tracker:FileSystem`, `tracker:Documents`, `tracker:Audio`, `tracker:Video`, `tracker:Pictures`, `tracker:Software` |
| Change API | `TrackerNotifier` — push via D-Bus. Events: `TRACKER_NOTIFIER_EVENT_CREATE`, `_DELETE`, `_UPDATE`. |
| How to subscribe | `tracker_sparql_connection_create_notifier()` → `tracker_notifier_signal_subscribe()` |
| Maturity | Active. TinySPARQL 3.9.alpha released January 2025. |

### Baloo (KDE)

File indexing for KDE Plasma. Uses LMDB. Focuses on small memory footprint.

| Property | Value |
|----------|-------|
| Indexes | File metadata via KFileMetaData extractors |
| Change API | **None** (intentionally). A patch to add D-Bus signals was proposed and reverted (too many signals for large operations). Use inotify directly. |
| CLI | `balooctl6 monitor` for interactive watching |
| Maturity | Active (KDE Frameworks 6). |

### Evolution Data Server (EDS)

Centralized PIM backend for GNOME. Contacts, calendars, tasks, memos.

| Property | Value |
|----------|-------|
| D-Bus services | `e-addressbook-factory`, `e-calendar-factory` |
| Key classes | `EDataCal` / `EDataCalFactory` (calendar D-Bus layer), `EDataBook` (addressbook D-Bus layer), `EDataCalView` / `EDataBookView` (live query push) |
| Change notifications | Push via D-Bus. Live views update all connected clients. |
| Backends | Local, Google, CalDAV/CardDAV, Exchange, LDAP |
| Libraries | `libecal-2.0`, `libebook-1.2`, `libebook-contacts-1.2`, `libedataserver-1.2` |
| Python | GObject Introspection bindings available |
| Maturity | Very mature. Core GNOME infrastructure. |

### Akonadi (KDE)

Centralized PIM storage for KDE. Contacts, calendars, email, notes.

| Property | Value |
|----------|-------|
| Change notifications | D-Bus signals for every write operation |
| Client API | `Akonadi::Monitor` (C++) — subscribes to D-Bus notifications, auto-retrieves changed items |
| Agent pattern | `AgentBase::Observer` with `itemAdded()`, `itemChanged()`, `itemRemoved()` callbacks |
| Search | Xapian-based indexing agent indexes emails, contacts, events, notes |
| Used by | KMail, KOrganizer, KAddressBook, Kalendar |
| Maturity | Active. Core KDE PIM infrastructure. |

### Zeitgeist

Activity logging framework. Logged file opens, web visits, conversations.
Applied data association algorithms (Winepi, Apriori).

| Property | Value |
|----------|-------|
| API | D-Bus (both push events to it and subscribe to activity streams) |
| Last release | 0.9.16 (2015-07-08) |
| Status | **Effectively unmaintained.** Still packaged in Debian/Ubuntu/Arch. |
| Relevance | Closest prior art to what we're building. Failed because: GNOME-only, no sync layer, no cross-platform story. |

### PipeWire / WirePlumber

Multimedia server (audio + video routing). Not a "data change" API in the
contacts/calendar sense, but relevant for media stream awareness.

| Property | Value |
|----------|-------|
| What it does | Audio routing, video capture, screen sharing |
| Change API | Registry events for node/port/link add/remove. `pw-metadata --monitor` for metadata changes. |
| Relevance | Could detect "user is playing music" or "user started a video call" — activity signals, not data changes. |
| Maturity | Active. Default on Fedora, Ubuntu, most modern distros. |

### xdg-desktop-portal

D-Bus service for sandboxed app access to host resources.

| Property | Value |
|----------|-------|
| Portals | FileChooser, Documents, Notification (v2), Screenshot, ScreenCast, Camera, etc. |
| Change notifications | **None.** Portals are for controlled access, not event streaming. |
| Relevance | Minimal for our use case. |

---

## macOS

### FSEvents

Kernel-level filesystem change notification (since macOS 10.5).

| Property | Value |
|----------|-------|
| API | `FSEventStreamCreate()`, `FSEventStreamScheduleWithRunLoop()`, `FSEventStreamStart()` |
| Events | Create, delete, modify, rename, mount/unmount |
| File-level | Since macOS 10.7 with `kFSEventStreamCreateFlagFileEvents` |
| Persistence | Event database persists across reboots. Query `sinceWhen` with stored event ID for catch-up. |
| Recursive | Yes (watches a directory tree) |
| Latency | Configurable coalescing |
| Push/Poll | Push (run loop callback) |
| Maturity | Very mature. Used internally by Spotlight. |
| Cross-platform | Rust `notify` crate abstracts over FSEvents and inotify |

### NSMetadataQuery (Spotlight)

System-wide metadata indexing and search.

| Property | Value |
|----------|-------|
| API | `NSMetadataQuery` (Cocoa, high-level), `MDQuery` (C, low-level) |
| Live queries | Subscribe to a predicate. Get `NSMetadataQueryDidFinishGatheringNotification` for initial results, `NSMetadataQueryDidUpdateNotification` as results change. |
| Scopes | `UserHomeScope`, `LocalComputerScope`, `UbiquitousDocumentsScope` (iCloud) |
| Metadata attributes | `kMDItemContentType`, `kMDItemFSName`, `kMDItemPixelHeight`, etc. |
| Push/Poll | Push (live query notifications) |
| Maturity | Very mature. |

### EventKit (Calendar / Reminders)

Access to system Calendar database.

| Property | Value |
|----------|-------|
| API | `EKEventStore`, `EKEvent`, `EKReminder` |
| Change notification | `EKEventStoreChangedNotification` via `NotificationCenter` |
| Granularity | Notification-only (no diff). Must refetch. Undocumented `EKEventStoreChangedObjectIDsUserInfoKey` may contain changed IDs. |
| Per-event check | `event.refresh()` returns true if still valid |
| Push/Poll | Push (notification-level) |
| Maturity | Very mature. macOS, iOS, watchOS. |

### Contacts.framework (CNContactStore)

Access to system Contacts database.

| Property | Value |
|----------|-------|
| API | `CNContactStore`, `CNContact` |
| Change notification | `CNContactStoreDidChangeNotification` via `NotificationCenter` |
| Granular history | `CNChangeHistoryFetchRequest` → `CNChangeHistoryAddContactEvent`, `UpdateContactEvent`, `DeleteContactEvent` |
| Push/Poll | Push (notification) + pull (history enumeration) |
| Caveats | Fires for both internal and external changes. Use macOS 10.12+ (bugs in 10.11). |
| Maturity | Mature. Since macOS 10.11 / iOS 9. |

### PhotoKit (PHPhotoLibrary)

Access to system photo library.

| Property | Value |
|----------|-------|
| API | `PHPhotoLibrary`, `PHPhotoLibraryChangeObserver`, `PHChange` |
| Change notification | `photoLibraryDidChange(_ changeInstance: PHChange)` — push |
| Detail | `PHFetchResultChangeDetails` gives inserted/removed/changed indices |
| Persistent history | `PHPersistentChangeToken` — track changes across app launches (macOS Big Sur+) |
| Push/Poll | Push with detailed diffs |
| Maturity | Very mature. |

### NSDistributedNotificationCenter

Cross-process notification dispatch.

| Property | Value |
|----------|-------|
| Known notifications | `com.apple.Music.playerInfo`, `com.apple.screenIsLocked/Unlocked`, `AppleInterfaceThemeChangedNotification`, accessibility changes |
| Caveats | Observing all notifications (`nil` name) broken since Catalina for unprivileged processes. Most names are undocumented and unstable. |
| Best reference | [SketchyBar community list](https://github.com/FelixKratz/SketchyBar/discussions/151) |
| Maturity | Mechanism is mature. Useful notifications are undocumented. |

### OSLogStore (Unified Logging)

Query system and app logs programmatically.

| Property | Value |
|----------|-------|
| API | `OSLogStore(scope: .system)`, `store.getEntries(at:)`, filter with `NSPredicate` |
| System-wide | macOS only, requires admin + entitlement |
| Push/Poll | **Poll only** |
| CLI | `log show`, `log stream`, `log collect` |
| Maturity | Mature. Since macOS 10.15 / iOS 15. |

---

## Android

### ContentObserver / ContentResolver

Universal mechanism for observing changes in any ContentProvider-backed
data store.

| Property | Value |
|----------|-------|
| API | `ContentResolver.registerContentObserver(uri, notifyForDescendants, observer)` |
| Callback | `ContentObserver.onChange(selfChange, uri)` |
| Push/Poll | Push (callback-based) |
| Granularity | Varies by provider. ContactsContract fires broad notifications. URI in onChange not always specific. No create/update/delete type. |
| Lifecycle | Register in `onResume()`, unregister in `onPause()` |
| Maturity | Very mature. Since API level 1. |

This is the pattern Android uses for everything below:

### MediaStore

| URI | `MediaStore.Images.Media.EXTERNAL_CONTENT_URI`, `Audio`, `Video` variants |
|-----|-------|
| Subscribe | `ContentObserver` on the relevant URI |

### ContactsContract

| URI | `ContactsContract.Contacts.CONTENT_URI`, `RawContacts`, `Data` |
|-----|-------|
| Subscribe | `ContentObserver`. Always fires on any contact change, even when observing a specific URI. |

### CalendarContract

| URI | `CalendarContract.Calendars.CONTENT_URI`, `Events`, `Reminders`, `Instances` |
|-----|-------|
| Subscribe | `ContentObserver`. Sync-adapter-aware (`CALLER_IS_SYNCADAPTER`). |

**No unified "something changed" stream exists.** But because every data
type uses the same ContentObserver pattern, wiring them into a single
handler is trivial.

---

## Windows

### ReadDirectoryChangesW

| Property | Value |
|----------|-------|
| API | `ReadDirectoryChangesW` |
| Details | File name + action type |
| Recursive | Optional |
| Push/Poll | Push (completion routine or IOCTL) |
| Limitations | Fixed-size buffer overflow loses ALL buffered events. Unreliable on network filesystems. |
| Since | Windows NT 3.51 SP3 |

### NTFS USN Change Journal

Persistent log of all changes on an NTFS volume.

| Property | Value |
|----------|-------|
| API | `DeviceIoControl()` with `FSCTL_QUERY_USN_JOURNAL`, `FSCTL_READ_USN_JOURNAL`, `FSCTL_ENUM_USN_DATA` |
| Scope | Volume-wide |
| Records | File reference number, reason flags (create, delete, rename, data extend, data overwrite), file name |
| Persistence | Survives reboots. Catch-up from stored USN. |
| Push/Poll | Semi-push (blocking read with `ReturnOnlyOnClose=0`) or poll |
| CLI | `fsutil usn` |
| Maturity | Very mature. Since Windows 2000. |

### Windows Search

System-wide content indexer. Uses USN Journal as change source.

| Property | Value |
|----------|-------|
| Query API | `ISearchQueryHelper` (AQS → SQL), OLE DB provider |
| Change notifications | `IRowsetEvents` for query result changes. `ISearchPersistentItemsChangedSink` to notify indexer of data changes. |
| Push/Poll | Query is poll; rowset events are push |
| Maturity | Mature. Ships with all Windows versions. |

### Windows Notification Facility (WNF)

Kernel-level pub/sub (since Windows 8). Used internally by Windows for
system-wide state signaling.

| Property | Value |
|----------|-------|
| API | `NtSubscribeWnfStateChange()`, `NtQueryWnfStateData()`, `NtUpdateWnfStateData()` (ntdll.dll) |
| Push/Poll | Push (callback via KEVENT per process) |
| **Status** | **Completely undocumented.** Reverse-engineered by security researchers. |
| Tools | SharpWnfSuite, `wnf` Rust crate |
| Maturity | Ships in all Windows 8+, but unsupported for third-party use. |

### UWP ContactStore / AppointmentStore

| Property | Value |
|----------|-------|
| Contacts | `ContactManager.RequestStoreAsync()` → `ContactStore.ChangeTracker.Enable()` → `GetChangeReader()` → `AcceptChanges()` |
| Appointments | `AppointmentStore.ChangeTracker` — same pattern |
| Change types | Created, modified, deleted (per change object) |
| Push/Poll | **Checkpoint-based pull** (enable tracking, later read deltas, advance checkpoint) |
| Requires | `contacts` / `appointments` capability declaration |
| Maturity | Since Windows 10. Some reports of AppointmentStore becoming unreliable. |

---

## Cross-Platform Protocols

### CalDAV (RFC 4791) / CardDAV (RFC 6352)

HTTP-based protocols for calendar and contact sync.

| Property | Value |
|----------|-------|
| Change detection | ETags (has it changed?), `sync-collection` (RFC 6578) for incremental deltas |
| Push | **Not in base protocol.** Some servers support WebSocket or push. |
| Local server option | Radicale, Baikal, local Nextcloud — all platforms can sync to it |
| OS support | macOS native, GNOME (EDS), KDE (Akonadi), Android (DAVx5), Windows (CalDav Synchronizer plugin) |
| Maturity | Very mature standard. |

A local CalDAV/CardDAV server could unify contacts/calendar across
platforms, but it's poll-based and adds infrastructure. For our use case,
hooking into the native push APIs per-platform and syncing through our
own event log is simpler and lower latency.

---

## Design Takeaways

1. **Every OS has what we need.** macOS is the richest (push APIs for
   files, contacts, calendar, photos, all with granular diffs). Android
   has the cleanest pattern (ContentObserver for everything). Linux has
   the pieces but they're fragmented across GNOME/KDE. Windows is the
   most awkward (undocumented WNF, checkpoint-based UWP APIs).

2. **The observer trait is the abstraction.** Each platform observer
   implements the same trait: "watch for changes, emit events." The
   daemon doesn't care whether the event came from inotify, FSEvents,
   CNContactStore, or ContentObserver.

3. **Start with filesystem, add domains incrementally.** Filesystem
   watching covers photos, notes, and documents — the 80% case. Contacts
   and calendars are the next tier. Email and browser history are further
   out (and harder — no good push APIs on most platforms).

4. **Zeitgeist is our cautionary tale.** It had the right idea (unified
   activity stream) but failed because: (a) GNOME-only, (b) no sync
   layer, (c) no mobile story, (d) no way to get data *out* (render,
   publish). We're building all four of those.
