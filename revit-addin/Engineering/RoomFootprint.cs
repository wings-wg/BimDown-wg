namespace BimDown.RevitAddin.Engineering;

internal readonly record struct PlanPoint(double X, double Y);

internal static class RoomFootprint
{
    // All coordinates in metres. The tolerance also closes roundoff between
    // consecutive boundary segments before writing the GeoJSON.
    internal const double Tolerance = 1e-6;

    internal static bool Near(PlanPoint a, PlanPoint b) =>
        Math.Abs(a.X - b.X) <= Tolerance && Math.Abs(a.Y - b.Y) <= Tolerance;

    internal static double[][][] Polygon(IReadOnlyList<List<PlanPoint>> loops)
    {
        if (loops.Count == 0) throw new ArgumentException("Missing room boundary loops.");
        foreach (var loop in loops)
        {
            if (loop.Count < 3 || loop.Any(p => !double.IsFinite(p.X) || !double.IsFinite(p.Y)) ||
                Math.Abs(SignedArea(loop)) <= Tolerance * Tolerance)
                throw new ArgumentException("Degenerate room boundary loop.");
            for (var i = 0; i < loop.Count; i++)
            {
                if (Near(loop[i], loop[(i + 1) % loop.Count]))
                    throw new ArgumentException("Room boundary has a zero-length edge.");
                var a = loop[i];
                var b = loop[(i + 1) % loop.Count];
                var c = loop[(i + 2) % loop.Count];
                if (Side(a, b, c) == 0 && (a.X - b.X) * (c.X - b.X) + (a.Y - b.Y) * (c.Y - b.Y) > 0)
                    throw new ArgumentException("Room boundary doubles back.");
                for (var j = i + 2; j < loop.Count; j++)
                    if ((i != 0 || j != loop.Count - 1) && EdgesMeet(loop, i, loop, j))
                        throw new ArgumentException("Room boundary intersects itself.");
            }
        }

        var depth = new int[loops.Count];
        for (var i = 0; i < loops.Count; i++)
            for (var j = i + 1; j < loops.Count; j++)
            {
                var a = loops[i];
                var b = loops[j];
                for (var p = 0; p < a.Count; p++)
                    for (var q = 0; q < b.Count; q++)
                        if (EdgesMeet(a, p, b, q)) throw new ArgumentException("Room boundary loops touch or intersect.");
                if (Contains(a, b[0])) depth[j]++;
                else if (Contains(b, a[0])) depth[i]++;
            }
        if (depth.Count(d => d == 0) != 1 || depth.Any(d => d > 1))
            throw new ArgumentException("Room has disconnected parts or an island inside a hole.");

        return loops.Select((loop, i) => (loop, depth: depth[i])).OrderBy(entry => entry.depth)
            .Select(entry =>
            {
                IEnumerable<PlanPoint> ring = entry.loop;
                if ((SignedArea(entry.loop) > 0) != (entry.depth == 0)) ring = ring.Reverse();
                var points = ring.Select(p => new[] { p.X, p.Y }).ToList();
                points.Add(points[0]);
                return points.ToArray();
            }).ToArray();
    }

    static double SignedArea(List<PlanPoint> loop)
    {
        var origin = loop[0];
        var twice = 0.0;
        for (var i = 1; i + 1 < loop.Count; i++)
            twice += Cross(origin, loop[i], loop[i + 1]);
        return twice / 2;
    }

    static bool Contains(List<PlanPoint> loop, PlanPoint p)
    {
        var inside = false;
        for (var i = 0; i < loop.Count; i++)
        {
            var a = loop[i];
            var b = loop[(i + 1) % loop.Count];
            if ((a.Y > p.Y) != (b.Y > p.Y) && p.X < a.X + (p.Y - a.Y) * (b.X - a.X) / (b.Y - a.Y))
                inside = !inside;
        }
        return inside;
    }

    static double Cross(PlanPoint a, PlanPoint b, PlanPoint p) =>
        (b.X - a.X) * (p.Y - a.Y) - (b.Y - a.Y) * (p.X - a.X);

    static int Side(PlanPoint a, PlanPoint b, PlanPoint p)
    {
        var cross = Cross(a, b, p);
        var tolerance = Tolerance * Math.Max(Math.Abs(b.X - a.X), Math.Abs(b.Y - a.Y));
        return Math.Abs(cross) <= tolerance ? 0 : Math.Sign(cross);
    }

    static bool Between(double v, double a, double b) =>
        v >= Math.Min(a, b) - Tolerance && v <= Math.Max(a, b) + Tolerance;

    static bool OnEdge(PlanPoint p, PlanPoint a, PlanPoint b) =>
        Between(p.X, a.X, b.X) && Between(p.Y, a.Y, b.Y);

    static bool EdgesMeet(List<PlanPoint> first, int i, List<PlanPoint> second, int j)
    {
        var a = first[i];
        var b = first[(i + 1) % first.Count];
        var c = second[j];
        var d = second[(j + 1) % second.Count];
        var ac = Side(a, b, c);
        var ad = Side(a, b, d);
        var ca = Side(c, d, a);
        var cb = Side(c, d, b);
        return ac * ad < 0 && ca * cb < 0 ||
            ac == 0 && OnEdge(c, a, b) || ad == 0 && OnEdge(d, a, b) ||
            ca == 0 && OnEdge(a, c, d) || cb == 0 && OnEdge(b, c, d);
    }
}
