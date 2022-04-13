import { expect, test } from "@playwright/test";
import { User, BookingStatus } from "@prisma/client";
import dayjs from "dayjs";

import { TestUtilCreateBookingOnUserId, TestUtilCreatePayment } from "./lib/dbSetup";
import { deleteAllBookingsByEmail } from "./lib/teardown";
import { selectFirstAvailableTimeSlotNextMonth } from "./lib/testUtils";

test.describe("Reschedule Tests", async () => {
  let currentUser: Partial<User> | null | undefined;
  // Using logged in state from globalSteup
  test.use({ storageState: "playwright/artifacts/proStorageState.json" });
  test.beforeAll(async () => {
    currentUser = await prisma?.user.findFirst({
      select: {
        id: true,
        email: true,
        username: true,
      },
      where: {
        email: "pro@example.com",
      },
    });
  });
  test.afterEach(async () => {
    try {
      await deleteAllBookingsByEmail("pro@example.com", {
        createdAt: { gte: dayjs().startOf("day").toISOString() },
      });
    } catch (error) {
      console.log("Error while trying to delete all bookings from pro user");
    }
  });

  test("Should do a booking request reschedule from /bookings", async ({ page }) => {
    const user = currentUser;
    const eventType = await prisma?.eventType.findFirst({
      where: {
        userId: user?.id,
        slug: "30min",
      },
    });
    let originalBooking;
    if (user && user.id && user.username && eventType) {
      originalBooking = await TestUtilCreateBookingOnUserId(user?.id, user?.username, eventType?.id, {
        status: BookingStatus.ACCEPTED,
      });
    }
    await page.goto("/event-types");

    await page.fill('input[name="email"]', "pro@example.com");

    await page.fill('input[name="password"]', "pro");

    await page.click('button[type="submit"]');

    await page.goto("/bookings/upcoming");

    await page.locator('[data-testid="reschedule"]').click();

    await page.locator('[data-testid="reschedule_request"]').click();

    await page.fill('[data-testid="reschedule_reason"]', "I can't longer have it");

    await page.locator('button[data-testid="send_request"]').click();

    // Find booking that was recently cancelled
    const booking = await prisma?.booking.findFirst({
      select: {
        id: true,
        uid: true,
        cancellationReason: true,
        status: true,
        rescheduled: true,
      },
      where: { id: originalBooking?.id },
    });

    expect(booking?.rescheduled).toBe(true);
    expect(booking?.cancellationReason).toBe("I can't longer have it");
    expect(booking?.status).toBe(BookingStatus.CANCELLED);
  });

  test("Should display former time when rescheduling availability", async ({ page }) => {
    const user = currentUser;
    const eventType = await prisma?.eventType.findFirst({
      where: {
        userId: user?.id,
        slug: "30min",
      },
    });
    let originalBooking;
    if (user && user.id && user.username && eventType) {
      originalBooking = await TestUtilCreateBookingOnUserId(user?.id, user?.username, eventType?.id, {
        status: BookingStatus.CANCELLED,
        rescheduled: true,
      });
    }
    await page.goto(
      `/${originalBooking?.user?.username}/${eventType?.slug}?rescheduleUid=${originalBooking?.uid}`
    );
    const formerTimeElement = await page.locator('[data-testid="former_time_p"]');
    await expect(formerTimeElement).toBeVisible();
  });

  test("Should display request reschedule send on bookings/cancelled", async ({ page }) => {
    await page.goto("/bookings/cancelled");

    const requestRescheduleSentElement = await page.locator('[data-testid="request_reschedule_sent"]');
    await expect(requestRescheduleSentElement).toBeVisible();
  });

  test("Should do a reschedule from user owner", async ({ page }) => {
    const user = currentUser;

    const eventType = await prisma?.eventType.findFirst({
      where: {
        userId: user?.id,
      },
    });
    if (user?.id && user?.username && eventType?.id) {
      const booking = await TestUtilCreateBookingOnUserId(user?.id, user?.username, eventType?.id, {
        rescheduled: true,
        status: BookingStatus.CANCELLED,
      });

      await page.goto(`/${user?.username}/${eventType?.slug}?rescheduleUid=${booking?.uid}`);

      await selectFirstAvailableTimeSlotNextMonth(page);

      await expect(page.locator('[name="name"]')).toBeDisabled();
      await expect(page.locator('[name="email"]')).toBeDisabled();
      await expect(page.locator('[name="notes"]')).toBeDisabled();

      await page.locator('[data-testid="confirm-reschedule-button"]').click();

      await page.waitForNavigation({
        url(url) {
          return url.pathname.endsWith("/success");
        },
      });

      await expect(page).toHaveURL(/.*success/);

      // NOTE: remove if old booking should not be deleted
      const oldBooking = await prisma?.booking.findFirst({ where: { id: booking?.id } });
      expect(oldBooking).toBeNull();

      const newBooking = await prisma?.booking.findFirst({ where: { fromReschedule: booking?.uid } });
      expect(newBooking).not.toBeNull();
    }
  });

  test("Unpaid rescheduling should go to payment page", async ({ page }) => {
    let user = currentUser;

    try {
      const eventType = await prisma?.eventType.findFirst({
        where: {
          userId: user?.id,
          slug: "paid",
        },
      });
      if (user?.id && user?.username && eventType?.id) {
        const booking = await TestUtilCreateBookingOnUserId(user?.id, user?.username, eventType?.id, {
          rescheduled: true,
          status: BookingStatus.CANCELLED,
          paid: false,
        });
        if (booking?.id) {
          await TestUtilCreatePayment(booking.id, {});
          await page.goto(`/${user?.username}/${eventType?.slug}?rescheduleUid=${booking?.uid}`);

          await selectFirstAvailableTimeSlotNextMonth(page);

          await expect(page.locator('[name="name"]')).toBeDisabled();
          await expect(page.locator('[name="email"]')).toBeDisabled();
          await expect(page.locator('[name="notes"]')).toBeDisabled();

          await page.locator('[data-testid="confirm-reschedule-button"]').click();

          await expect(page).toHaveURL(/.*payment/);
        }
      }
    } catch (error) {
      await prisma?.payment.delete({
        where: {
          externalId: "DEMO_PAYMENT_FROM_DB",
        },
      });
    }
  });

  test("Paid rescheduling should go to success page", async ({ page }) => {
    let user = currentUser;

    try {
      const eventType = await prisma?.eventType.findFirst({
        where: {
          userId: user?.id,
          slug: "paid",
        },
      });
      if (user?.id && user?.username && eventType?.id) {
        const booking = await TestUtilCreateBookingOnUserId(user?.id, user?.username, eventType?.id, {
          rescheduled: true,
          status: BookingStatus.CANCELLED,
          paid: true,
        });
        if (booking?.id) {
          await TestUtilCreatePayment(booking.id, {});
          await page.goto(`/${user?.username}/${eventType?.slug}?rescheduleUid=${booking?.uid}`);

          await selectFirstAvailableTimeSlotNextMonth(page);

          await expect(page.locator('[name="name"]')).toBeDisabled();
          await expect(page.locator('[name="email"]')).toBeDisabled();
          await expect(page.locator('[name="notes"]')).toBeDisabled();

          await page.locator('[data-testid="confirm-reschedule-button"]').click();

          await expect(page).toHaveURL(/.*success/);
        }
      }
    } catch (error) {
      await prisma?.payment.delete({
        where: {
          externalId: "DEMO_PAYMENT_FROM_DB",
        },
      });
    }
  });
});