package org.onemindlabs.airhop.tor

import org.junit.Assert.assertEquals
import org.junit.Test

class AirhopTransportTest {
    // The shapes the app bundles (src/data/bridges.ts, from Moat).
    private val obfs4 =
        "obfs4 146.57.248.225:22 10A6CD36A537FCE513A322361547444B393989F0 " +
            "cert=K1gDtDAIcUfeLqbstggjIw2rtgIKqdIhUlHp82XRqNSq/mtAjp1BIC9vHKJ2FAEpGssTPw iat-mode=0"
    private val snowflake =
        "snowflake 192.0.2.3:80 2B280B23E1107BB62ABFC40DDCC8824814F80A72 " +
            "fingerprint=2B280B23E1107BB62ABFC40DDCC8824814F80A72 " +
            "url=https://1098762253.rsc.cdn77.org/ fronts=app.datapacket.com,www.datapacket.com"

    @Test
    fun eachTransportNamedIsStarted() {
        assertEquals(setOf(AirhopTransport.OBFS4), AirhopTransport.namedIn("$obfs4\n$obfs4"))
        assertEquals(
            setOf(AirhopTransport.OBFS4, AirhopTransport.SNOWFLAKE),
            AirhopTransport.namedIn("$obfs4\n$snowflake"),
        )
    }

    // The torrc form bridges.torproject.org also hands out, pasted as is.
    @Test
    fun aLeadingBridgeWordIsSkipped() {
        assertEquals(setOf(AirhopTransport.OBFS4), AirhopTransport.namedIn("Bridge $obfs4"))
        assertEquals(
            setOf(AirhopTransport.SNOWFLAKE),
            AirhopTransport.namedIn("  bridge   $snowflake\r\n"),
        )
    }

    // Nothing to start for a comment, a direct bridge or a transport Airhop does
    // not ship; Arti refuses the last when it parses the line.
    @Test
    fun linesNamingNoShippedTransportStartNothing() {
        val lines =
            listOf(
                "",
                "# $obfs4",
                "192.0.2.9:9001 0123456789ABCDEF0123456789ABCDEF01234567",
                obfs4.replaceFirst("obfs4", "meek_lite"),
                obfs4.replaceFirst("obfs4", "webtunnel"),
            )
        assertEquals(emptySet<AirhopTransport>(), AirhopTransport.namedIn(lines.joinToString("\n")))
    }
}
