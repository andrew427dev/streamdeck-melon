import AppKit
import ApplicationServices

typealias Element = AXUIElement
typealias Record = [String: Any]
let bundle = "com.iloen.macmelon"

struct Problem: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}
func attribute(_ element: Element, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func element(_ node: Element, _ name: String) -> Element? {
    guard let value = attribute(node, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! Element)
}
func nodes(_ node: Element, _ key: String = "AXChildren") -> [Element] {
    attribute(node, key) as? [Element] ?? []
}
func string(_ element: Element, _ name: String) -> String {
    let raw = attribute(element, name)
    if let value = raw as? String { return value }
    if let value = raw as? NSAttributedString { return value.string }
    return ""
}
func role(_ node: Element) -> String { string(node, "AXRole") }
func name(_ node: Element) -> String {
    for key in ["AXValue", "AXTitle", "AXDescription"] {
        let text = string(node, key)
        if !text.isEmpty { return text }
    }
    return ""
}
func find(_ roots: [Element], depth: Int = 7, skip: Set<String> = [], _ matches: (Element, String) -> Bool) -> Element? {
    var level = roots
    for _ in 0...depth {
        var next: [Element] = []
        for node in level {
            let r = role(node)
            if matches(node, r) { return node }
            if !skip.contains(r) { next.append(contentsOf: nodes(node)) }
        }
        if next.isEmpty { break }
        level = next
    }
    return nil
}
func press(_ node: Element?, _ failure: String) throws {
    guard let node, (attribute(node, "AXEnabled") as? Bool) != false,
          AXUIElementPerformAction(node, "AXPress" as CFString) == .success else { throw Problem(failure) }
}
func poll<T>(_ fetch: () -> T?) -> T? {
    for attempt in 0..<12 {
        if let result = fetch() { return result }
        if attempt < 11 { Thread.sleep(forTimeInterval: 0.07) }
    }
    return nil
}
func checked(_ node: Element) -> Bool {
    !string(node, "AXMenuItemMarkChar").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
}
let skipContent: Set<String> = ["AXScrollArea", "AXTable", "AXOutline", "AXWebArea", "AXRow"]

struct Player {
    let app: Element
    let process: NSRunningApplication
    var windows: [Element] {
        let listed = nodes(app,"AXWindows")
        if !listed.isEmpty { return listed }
        for key in ["AXMainWindow", "AXFocusedWindow"] {
            if let window = element(app,key) { return [window] }
        }
        return nodes(app).filter { role($0) == "AXWindow" }
    }
    func menu(_ title: String) -> [Element] {
        guard let bar = element(app, "AXMenuBar"), let top = nodes(bar).first(where: {name($0) == title}),
              let menu = nodes(top).first else { return [] }
        return nodes(menu)
    }
    func parts() throws -> (outer: [Element], inner: [Element], toggle: Element) {
        guard let icon = find(windows, depth: 8, skip: skipContent, { n,r in
            r == "AXImage" && name(n).lowercased().replacingOccurrences(of: "_", with: " ").contains("player bar playlist")
        }), let parent = element(icon, "AXParent") else { throw Problem("멜론 기본모드를 열어 주세요") }
        let outer = nodes(parent)
        guard let i = outer.firstIndex(of: icon), i + 2 < outer.count, role(outer[i+2]) == "AXButton",
              let group = outer.dropFirst(i+3).first(where: { child in
                  let children = nodes(child)
                  return children.filter { ["AXButton","AXCheckBox"].contains(role($0)) }.count >= 5
              }) else { throw Problem("멜론 재생 막대를 찾을 수 없습니다") }
        return (outer, nodes(group), outer[i+2])
    }
    func current(_ inner: [Element]) -> (title: String, artist: String) {
        // Melon exposes the marquee as a combined title/artist accessibility label.
        if let label = find(inner, depth:2, { n,r in
            name(n).contains(" - ")
        }) {
            let text = name(label)
            if let split = text.range(of:" - ",options:.backwards) {
                return (String(text[..<split.lowerBound]),String(text[split.upperBound...]))
            }
        }
        return ("","")
    }
    func state() throws -> Record {
        let menuItems = menu("재생")
        var result: Record = ["running":true]
        let marked = menuItems.filter(checked).map(name)
        result["repeat"] = marked.first { ["전체 반복","한곡 반복","한 곡 반복","반복 없음"].contains($0) }
        if let item = menuItems.first(where:{ ["재생","재생하기","일시정지","일시 정지"].contains(name($0)) }) {
            result["playing"] = name(item).contains("정지")
        }
        if let p = try? parts() {
            let track = current(p.inner)
            result["title"] = track.title
            result["artist"] = track.artist
            // The seek control is attached to the window; the volume slider is inside the player bar.
            if let seek = windows.lazy.flatMap({ nodes($0) }).first(where: { role($0) == "AXSlider" }),
               let position = attribute(seek,"AXValue") as? NSNumber,
               let maximum = attribute(seek,"AXMaxValue") as? NSNumber,
               maximum.doubleValue > 0, position.doubleValue >= 0, position.doubleValue <= maximum.doubleValue {
                result["elapsed"] = position.intValue
                result["duration"] = maximum.intValue
            } else {
                // Some versions expose both clocks on a text element, via separate AX attributes.
                for node in p.inner {
                    let labels = ["AXTitle","AXValue","AXDescription"].map { string(node,$0) }
                    let clocks = labels.joined(separator:" ").split(whereSeparator: { !$0.isNumber && $0 != ":" })
                    let seconds = clocks.compactMap { clock -> Int? in
                        let pair = clock.split(separator:":")
                        guard pair.count == 2, let m = Int(pair[0]), let s = Int(pair[1]), s < 60 else { return nil }
                        return m * 60 + s
                    }
                    if seconds.count >= 2 {
                        let pair = seconds.prefix(2)
                        result["duration"] = pair.max()
                        result["elapsed"] = pair.min()
                        break
                    }
                }
            }
            let toggles = p.inner.filter { role($0) == "AXCheckBox" }
            if let first = toggles.first, let on = attribute(first,"AXValue") as? NSNumber { result["playing"] = on.boolValue }
            if toggles.count >= 2, let on = attribute(toggles[1],"AXValue") as? NSNumber { result["shuffle"] = on.boolValue }
            if let vol = p.outer.first(where:{role($0) == "AXSlider"}) { result["volume"] = attribute(vol,"AXValue") as? NSNumber }
        } else { result["view"] = "멜론 기본모드를 열어 주세요" }
        return result
    }
    func playback(_ op: String) throws {
        let items = menu("재생")
        let mapping = ["next":"다음 곡 재생","previous":"이전 곡 재생","pause":"일시정지","play":"재생"]
        if op == "shuffle" || op == "repeat" {
            let inner = try parts().inner
            let controls = inner.prefix(5).map(role)
            guard controls.count == 5, controls[0] == "AXButton", controls[1] == "AXButton",
                  controls[3] == "AXButton", ["AXCheckBox","AXButton"].contains(controls[4]) else { throw Problem("재생 방식 단추를 확인해 주세요") }
            try press(inner[op == "repeat" ? 0 : 4],"재생 방식을 바꿀 수 없습니다")
            return
        }
        let toggle = items.first { ["일시정지","일시 정지","재생","재생하기"].contains(name($0)) }
        if ["toggle","pause","play"].contains(op) {
            guard let toggle else { throw Problem("멜론 재생 메뉴를 찾을 수 없습니다") }
            let playing = (try? state()["playing"] as? Bool) ?? name(toggle).contains("정지")
            if (op == "pause" && !playing) || (op == "play" && playing) { return }
            try press(toggle, "현재 곡을 조작할 수 없습니다")
        } else {
            try press(items.first {name($0) == mapping[op]}, "재생할 곡을 확인해 주세요")
        }
    }
    func volume(_ delta: Int) throws {
        guard let slider = try parts().outer.first(where:{role($0) == "AXSlider"}),
              let old = attribute(slider,"AXValue") as? NSNumber else { throw Problem("멜론 볼륨을 찾을 수 없습니다") }
        let target = max(0,min(100,old.intValue + delta))
        guard AXUIElementSetAttributeValue(slider,"AXValue" as CFString,NSNumber(value:target)) == .success else { throw Problem("볼륨을 조절할 수 없습니다") }
    }
    func queueTable() -> Element? {
        find(windows, depth: 9, skip: ["AXTable","AXOutline","AXWebArea","AXRow","AXColumn"]) { node,r in
            r == "AXTable" && nodes(node,"AXColumns").contains { name($0) == "MPPlaylistSongNameColumn" || string($0,"AXIdentifier") == "MPPlaylistSongNameColumn" }
        }
    }
    func openQueue() throws -> Element {
        // Only inspect the queue tree when a deck action explicitly needs it.
        let p = try parts()
        if let icon = p.outer.first(where:{ role($0) == "AXImage" && name($0).contains("playlist") }),
           !name(icon).lowercased().hasSuffix("on") { try press(p.toggle, "멜론 재생목록을 열어 주세요") }
        guard let table = poll({queueTable()}) else { throw Problem("멜론 재생목록에서 ‘곡’ 탭을 열어 주세요") }
        return table
    }
    func rowInfo(_ row: Element) -> (title: String, artist: String, album: String, active: Bool) {
        let cells = nodes(row)
        var texts: [String] = []
        var active = false
        for cell in cells {
            let contents = nodes(cell)
            if contents.contains(where:{ name($0).replacingOccurrences(of:"_",with:" ").contains("eq playlist") }) { active = true }
            if let text = contents.first(where:{ role($0) == "AXStaticText" }), !name(text).isEmpty { texts.append(name(text)) }
        }
        return (texts.first ?? "", texts.count > 1 ? texts[1] : "", texts.count > 2 ? texts[2] : "", active)
    }
    func reveal(_ row: Element, table: Element) throws {
        guard AXUIElementSetAttributeValue(table,"AXSelectedRows" as CFString,[row] as CFArray) == .success ||
                AXUIElementSetAttributeValue(row,"AXSelected" as CFString,kCFBooleanTrue) == .success else {
            throw Problem("재생목록에서 곡을 선택할 수 없습니다")
        }
        _ = AXUIElementPerformAction(row,"AXScrollToVisible" as CFString)
    }
    func point(_ row: Element, table: Element) throws -> CGPoint {
        func rect(_ n: Element) -> CGRect? {
            guard let pos = attribute(n,"AXPosition"), CFGetTypeID(pos) == AXValueGetTypeID(),
                  let size = attribute(n,"AXSize"), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
            var pt = CGPoint.zero, sz = CGSize.zero
            guard AXValueGetValue(pos as! AXValue,.cgPoint,&pt), AXValueGetValue(size as! AXValue,.cgSize,&sz) else {return nil}
            return CGRect(origin:pt,size:sz)
        }
        guard let viewport = element(table,"AXParent").flatMap(rect),
              let cell = nodes(row).dropFirst().first, let area = rect(cell) else { throw Problem("목록 창에서 곡을 표시해 주세요") }
        let visible = area.intersection(viewport)
        guard !visible.isNull, visible.width > 4, visible.height > 3 else { throw Problem("멜론 목록에서 곡이 보이도록 스크롤해 주세요") }
        return CGPoint(x:visible.midX,y:visible.midY)
    }
    func clickRow(_ row: Element, table: Element, context: Bool) throws {
        // Melon implements these actions on table mouse events. Confirm the visible
        // accessibility row under the pointer before dispatching each click.
        _ = process.activate(options:[.activateIgnoringOtherApps])
        guard let _ = poll({ process.isActive ? true : nil }) else { throw Problem("멜론 창을 앞으로 열어 주세요") }
        if let window = element(table,"AXWindow") { _ = AXUIElementPerformAction(window,"AXRaise" as CFString) }
        try reveal(row,table:table)
        func hit(_ pt: CGPoint) -> Bool {
            var leaf:Element?
            guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(),Float(pt.x),Float(pt.y),&leaf) == .success,
                  let initial = leaf else { return false }
            var pid:pid_t = 0
            guard AXUIElementGetPid(initial,&pid) == .success, pid == process.processIdentifier else { return false }
            var next:Element? = initial
            for _ in 0..<12 {
                guard let n=next else {break}
                if CFEqual(n,row) {return true}
                next=element(n,"AXParent")
            }
            return false
        }
        func visiblePoint() -> CGPoint? {
            guard let pt = try? point(row,table:table), hit(pt) else {return nil}
            return pt
        }
        var pos = visiblePoint()
        if pos == nil {
            // The queue uses an outer scroll area and can virtualize its rows.
            let rows=nodes(table,"AXRows")
            if let i=rows.firstIndex(of:row),rows.count>1,
               let window=element(table,"AXWindow"),
               let scroll=find([window],depth:10,skip:["AXTable","AXOutline","AXRow","AXColumn"],{n,r in
                   r=="AXScrollBar" && string(n,"AXOrientation")=="AXVerticalOrientation" && (attribute(n,"AXEnabled") as? Bool) != false
               }) {
                _ = AXUIElementSetAttributeValue(scroll,"AXValue" as CFString,NSNumber(value:Double(i)/Double(rows.count-1)))
            }
            pos=poll(visiblePoint)
        }
        guard let pt=pos else {throw Problem("멜론 재생목록에서 선택한 행을 표시해 주세요")}
        let button: CGMouseButton = context ? .right : .left
        for count in 1...(context ? 1 : 2) {
            guard hit(pt) else {throw Problem("멜론 창 위치가 바뀌었습니다")}
            for type: CGEventType in (context ? [.rightMouseDown,.rightMouseUp] : [.leftMouseDown,.leftMouseUp]) {
                guard let event=CGEvent(mouseEventSource:nil,mouseType:type,mouseCursorPosition:pt,mouseButton:button) else {throw Problem("곡 선택 실패")}
                event.setIntegerValueField(.mouseEventClickState,value:Int64(count))
                event.post(tap:.cghidEventTap)
                Thread.sleep(forTimeInterval:0.025)
            }
        }
    }
    func trackMenu(_ table:Element) -> Element? {
        let focused=element(app,"AXFocusedUIElement")
        // Popup menus may attach to a secondary group under AXChildren while
        // AXWindows is empty and AXMainWindow only exposes the main player's subtree.
        let roots=nodes(app).filter {role($0)=="AXWindow"}+windows+[focused,element(table,"AXParent")].compactMap{$0}
        return find(roots,depth:10,skip:["AXMenuBar","AXTable","AXRow","AXColumn","AXOutline","AXWebArea"]) { n,r in
            r=="AXMenu" && nodes(n).contains{string($0,"AXIdentifier")=="onClickLike:"}
        }
    }
    func queue(_ request: Record, _ op: String) throws -> Record {
        let table: Element
        if op == "queuePreview" {
            if let visibleTable = queueTable() { table = visibleTable }
            else if request["restoreOnLaunch"] as? Bool == true { table = try openQueue() }
            else { return [:] }
        } else {
            table = try openQueue()
        }
        let rows = nodes(table,"AXRows")
        guard !rows.isEmpty else { throw Problem("재생목록이 비어 있습니다") }
        let visible = nodes(table,"AXVisibleRows")
        func currentIndex() throws -> Int {
            let track = current(try parts().inner)
            if let i = request["currentIndex"] as? Int, rows.indices.contains(i), rowInfo(rows[i]).active { return i }
            let visibleSet = Set(visible)
            let candidates = visible.isEmpty ? rows : visible + rows.filter { !visibleSet.contains($0) }
            var matching: [Element] = []
            for row in candidates {
                let info = rowInfo(row)
                if info.active, let i = rows.firstIndex(of:row) { return i }
                if !track.title.isEmpty, info.title == track.title, info.artist == track.artist {matching.append(row)}
            }
            if matching.count == 1, let i = rows.firstIndex(of:matching[0]) { return i }
            throw Problem("재생 중인 곡을 목록에서 찾을 수 없습니다")
        }
        let index: Int
        var currentPosition: Int?
        var album: String?
        if op == "queuePreview" {
            guard let playing = try? currentIndex() else { return [:] }
            currentPosition = playing
            album = rowInfo(rows[playing]).album
            guard playing + 1 < rows.count else { return ["end":true,"currentIndex":playing,"album":album ?? ""] }
            index = playing + 1
        }
        else if op == "like" || op == "add" { index = try currentIndex() }
        else if let i = request["index"] as? Int { index = min(rows.count-1,max(0,i)) }
        else { index = (try? currentIndex()) ?? 0 }
        let row = rows[index]
        var info = rowInfo(row)
        if info.title.isEmpty && op != "queuePreview" {
            _ = AXUIElementPerformAction(row,"AXScrollToVisible" as CFString)
            info = rowInfo(row)
        }
        guard !info.title.isEmpty else { throw Problem("목록의 곡 정보를 읽을 수 없습니다") }
        if op == "queuePlay" {
            guard request["title"] as? String == info.title, request["artist"] as? String == info.artist,
                  request["index"] as? Int == index else { throw Problem("목록이 바뀌었습니다. 다시 선택해 주세요") }
            try clickRow(row,table:table,context:false)
            guard poll({
                guard let state=try? self.state(),state["playing"] as? Bool==true,
                      let t=state["title"] as? String,let a=state["artist"] as? String,
                      t+" - "+a==info.title+" - "+info.artist else {return nil as Bool?}
                return true
            }) == true else { throw Problem("선택한 곡의 재생을 확인할 수 없습니다") }
        }
        if op == "like" || op == "add" {
            try clickRow(row,table:table,context:true)
            Thread.sleep(forTimeInterval:0.22)
            guard let menu=poll({trackMenu(table)}) else {throw Problem("멜론의 곡 메뉴를 열 수 없습니다")}
            defer { _ = AXUIElementPerformAction(menu,"AXCancel" as CFString) }
            let items = nodes(menu)
            let header=items.first{string($0,"AXIdentifier")=="onClickName:"}
            guard let header,name(header)==info.title+" - "+info.artist else { throw Problem("곡이 바뀌었습니다. 다시 눌러 주세요") }
            if op == "like" { try press(items.first {string($0,"AXIdentifier") == "onClickLike:"}, "좋아요를 변경할 수 없습니다") }
            else {
                let listName = (request["list"] as? String ?? "").trimmingCharacters(in:.whitespacesAndNewlines)
                guard !listName.isEmpty else { throw Problem("설정에 플레이리스트 이름을 입력해 주세요") }
                let sub = items.first { name($0) == "플레이리스트에 담기" }.flatMap { nodes($0).first }
                let matches = sub.map { nodes($0).filter { name($0) == listName && string($0,"AXIdentifier") == "onClickAddToPlaylist:" } } ?? []
                guard matches.count == 1 else { throw Problem("같은 이름의 목록이 하나인지 확인해 주세요") }
                try press(matches[0], "플레이리스트에 담을 수 없습니다")
            }
        }
        var result: Record = ["index":index,"count":rows.count,"title":info.title,"artist":info.artist]
        result["currentIndex"] = currentPosition
        result["album"] = album
        if index + 1 < rows.count { result["nextTitle"] = rowInfo(rows[index + 1]).title }
        return result
    }
}

func handle(_ r: Record) throws -> Record {
    let op = r["op"] as? String ?? ""
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier:bundle).first else {
        if op == "status" { return ["running":false] }
        throw Problem("멜론을 먼저 열어 주세요")
    }
    guard AXIsProcessTrusted() else { throw Problem("손쉬운 사용 권한 필요") }
    let p = Player(app:AXUIElementCreateApplication(app.processIdentifier), process:app)
    AXUIElementSetMessagingTimeout(p.app,2.0)
    switch op {
    case "status":return try p.state()
    case "volume":try p.volume(r["delta"] as? Int ?? 0)
    case "toggle","next","previous","play","pause","repeat","shuffle":try p.playback(op)
    case "queue","queuePreview","queuePlay","like","add":return try p.queue(r,op)
    default:throw Problem("알 수 없는 동작입니다")
    }
    return [:]
}
do {
    let request = try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as? Record ?? [:]
    let data = try JSONSerialization.data(withJSONObject: ["ok":true,"data":try handle(request)])
    FileHandle.standardOutput.write(data)
} catch {
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject:["ok":false,"error":error.localizedDescription]))
}
