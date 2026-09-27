package org.onemindlabs.airhop.lan

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalInterfaceFilterTest {
    // Wi-Fi joined or served, Ethernet and USB tethering carry local peers.
    @Test
    fun localInterfacesAreAccepted() {
        val local = listOf("wlan0", "wlan1", "ap0", "swlan0", "softap0", "eth0", "rndis0", "usb0")
        for (name in local) assertTrue(name, isLocalInterface(name))
    }

    // Loopback is another app on this phone; cellular is the carrier's network.
    @Test
    fun loopbackAndCellularAreRefused() {
        val other = listOf("lo", "rmnet0", "rmnet_data0", "ccmni0", "dummy0", "aware_data0")
        for (name in other) assertFalse(name, isLocalInterface(name))
        assertFalse(isLocalInterface(null))
    }
}
