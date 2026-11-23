// smoothy-vision: Apple Vision scans for the Smoothy Agent Bridge (macOS only).
//
//   smoothy-vision faces <image>...   one JSON line per image:
//     {"path", "faces", "eye":[ex,ey] | null, "box":[x,y,w,h] | null, "width"}
//     eye = midpoint of the largest face's eyes, box = that face; normalized, origin top-left.
//     Without eye landmarks the eye line is estimated at 62 % of the face height.
//   smoothy-vision hands <image>...   one JSON line per image:
//     {"path", "face": bool, "covered": bool, "points": n}
//     points = hand landmarks (confidence > 0.3) inside the face box (grown 10 %),
//     upper 55 % only; covered when 4 or more. Without a face a central box is used.
//
// Ported from the Video 01 tools (eyes.swift, handface.swift).

import Foundation
import ImageIO
import Vision

func load(_ path: String) -> CGImage? {
  guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
  return CGImageSourceCreateImageAtIndex(source, 0, nil)
}

func emit(_ object: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), let line = String(data: data, encoding: .utf8) {
    print(line)
  }
}

func round4(_ value: CGFloat) -> Double { (Double(value) * 10000).rounded() / 10000 }

func faces(_ path: String) {
  guard let image = load(path) else { emit(["path": path, "error": "unreadable"]); return }
  let request = VNDetectFaceLandmarksRequest()
  try? VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
  let results = request.results ?? []
  guard let face = results.max(by: { $0.boundingBox.width < $1.boundingBox.width }) else {
    emit(["path": path, "faces": 0, "eye": NSNull(), "box": NSNull(), "width": 0]); return
  }
  let bb = face.boundingBox
  func center(_ region: VNFaceLandmarkRegion2D?) -> CGPoint? {
    guard let region = region, region.pointCount > 0 else { return nil }
    var x: CGFloat = 0, y: CGFloat = 0
    for point in region.normalizedPoints { x += point.x; y += point.y }
    return CGPoint(x: x / CGFloat(region.pointCount), y: y / CGFloat(region.pointCount))
  }
  var ex = bb.midX, ey = 1 - (bb.origin.y + bb.height * 0.62), estimated = true
  if let left = center(face.landmarks?.leftEye), let right = center(face.landmarks?.rightEye) {
    ex = bb.origin.x + (left.x + right.x) / 2 * bb.width
    ey = 1 - (bb.origin.y + (left.y + right.y) / 2 * bb.height)
    estimated = false
  }
  emit([
    "path": path, "faces": results.count, "eye": [round4(ex), round4(ey)], "estimated": estimated,
    "box": [round4(bb.minX), round4(1 - bb.maxY), round4(bb.width), round4(bb.height)], "width": round4(bb.width)
  ])
}

func hands(_ path: String) {
  guard let image = load(path) else { emit(["path": path, "error": "unreadable"]); return }
  let faceRequest = VNDetectFaceRectanglesRequest()
  let handRequest = VNDetectHumanHandPoseRequest()
  handRequest.maximumHandCount = 2
  try? VNImageRequestHandler(cgImage: image, options: [:]).perform([faceRequest, handRequest])
  let found = (faceRequest.results ?? []).sorted { $0.boundingBox.width > $1.boundingBox.width }
  let box = found.first.map { $0.boundingBox.insetBy(dx: -$0.boundingBox.width * 0.1, dy: -$0.boundingBox.height * 0.1) } ?? CGRect(x: 0.33, y: 0.35, width: 0.36, height: 0.5)
  var count = 0
  for hand in handRequest.results ?? [] {
    guard let points = try? hand.recognizedPoints(.all) else { continue }
    for (_, point) in points where point.confidence > 0.3 && box.contains(point.location) && point.location.y > box.minY + box.height * 0.45 {
      count += 1
    }
  }
  emit(["path": path, "face": !found.isEmpty, "covered": !found.isEmpty && count >= 4, "points": count])
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first, ["faces", "hands"].contains(command) else {
  FileHandle.standardError.write("usage: smoothy-vision faces|hands <image>...\n".data(using: .utf8)!)
  exit(2)
}
for path in args.dropFirst() {
  autoreleasepool { command == "faces" ? faces(path) : hands(path) }
}
