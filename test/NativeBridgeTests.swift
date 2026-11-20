import Foundation

@main
struct NativeBridgeTests {
    static func main() throws {
        let complete = QueueRowInfo(columns: ["", "Song", "Artist", "Album", "3:00"], active: true)
        precondition(complete.title == "Song" && complete.artist == "Artist" && complete.album == "Album")
        let missingTitle = QueueRowInfo(columns: ["", "", "Artist", "Album", "3:00"], active: false)
        precondition(missingTitle.title.isEmpty, "제목이 비어 있으면 가수를 제목으로 옮기면 안 됩니다")
        precondition(missingTitle.artist == "Artist" && missingTitle.album == "Album")
        let missingArtist = QueueRowInfo(columns: ["", "Song", "", "Album", "3:00"], active: false)
        precondition(missingArtist.artist.isEmpty && missingArtist.album == "Album")
        let missingAlbum = QueueRowInfo(columns: ["", "Song", "Artist", "", "3:00"], active: false)
        precondition(missingAlbum.album.isEmpty)
        precondition(QueueRowInfo(columns: [], active: false).title.isEmpty)
        precondition(complete.active && !missingTitle.active)
        print("Native queue metadata tests passed")

        let cancellation = QueueCancellation()
        var calls = 0
        do {
            let _: Bool? = try cancellation.poll {
                calls += 1
                cancellation.request()
                return true
            }
            preconditionFailure("취소 후 성공을 반환하면 안 됩니다")
        } catch is QueueMoveCancelled {}
        precondition(calls == 1)
        do {
            let _: Bool? = try cancellation.poll { calls += 1; return true }
            preconditionFailure("이미 취소된 작업을 다시 시작하면 안 됩니다")
        } catch is QueueMoveCancelled {}
        precondition(calls == 1)

        var events: [String] = []
        do {
            try withRestoredShuffle(disable: { events.append("disable") }, restore: { events.append("restore") }) {
                events.append("move")
                try cancellation.check()
                events.append("play")
            }
            preconditionFailure("취소가 호출자에게 전달되어야 합니다")
        } catch is QueueMoveCancelled {}
        precondition(events == ["disable", "move", "restore"])
        events = []
        try withRestoredShuffle(disable: { events.append("disable") }, restore: { events.append("restore") }) {
            events.append("play")
        }
        precondition(events == ["disable", "play", "restore"])
        events = []
        do {
            try withRestoredShuffle(disable: { events.append("disable") }, restore: { events.append("restore") }) {
                throw Problem("곡 이동 실패")
            }
            preconditionFailure("곡 이동 실패가 전달되어야 합니다")
        } catch let error as Problem {
            precondition(error.errorDescription == "곡 이동 실패")
        }
        precondition(events == ["disable", "restore"])
        do {
            try withRestoredShuffle(disable: {}, restore: { throw Problem("복원 실패") }) {
                throw QueueMoveCancelled()
            }
            preconditionFailure("복원 실패가 전달되어야 합니다")
        } catch let error as Problem {
            precondition(error.errorDescription == "복원 실패")
        }

        let signalled = QueueCancellation()
        signalled.listenForTermination()
        kill(getpid(), SIGTERM)
        var received = false
        for _ in 0..<100 {
            do { try signalled.check() }
            catch is QueueMoveCancelled { received = true; break }
            Thread.sleep(forTimeInterval: 0.01)
        }
        precondition(received, "SIGTERM이 협조적 취소로 전달되어야 합니다")
        print("Native cancellation and shuffle restoration tests passed")
    }
}
