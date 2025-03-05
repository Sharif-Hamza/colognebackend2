import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

dotenv.config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Initialize Supabase client
const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY
);

// Configure CORS with specific options
app.use(cors({
  origin: process.env.FRONTEND_URL.replace(/\/$/, ''), // Remove trailing slash if present
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400 // Cache preflight request for 24 hours
}));

// Parse JSON payloads
app.use(express.json({
  verify: (req, res, buf) => {
    if (req.originalUrl === '/webhook') {
      req.rawBody = buf.toString();
    }
  }
}));

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'Cologne Ologist API',
    status: 'running',
    endpoints: ['/create-checkout-session', '/checkout-session/:sessionId', '/webhook']
  });
});

// Create checkout session
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { items, userId, email, shippingOption } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'Invalid items data' });
    }

    const lineItems = items.map(item => {
      // Create the product data object
      const productData = {
        name: item.name,
        description: item.description,
        metadata: {
          productId: item.id
        }
      };
      
      // Only add images if image_url exists and is not empty
      if (item.image_url && item.image_url.trim() !== '') {
        productData.images = [item.image_url];
        productData.metadata.image_url = item.image_url;
      }
      
      return {
        price_data: {
          currency: 'usd',
          product_data: productData,
          unit_amount: item.price,
        },
        quantity: item.quantity,
      };
    });

    // Generate a UUID for the order
    const orderId = randomUUID();

    // Ensure the URL doesn't have double slashes
    const baseUrl = process.env.FRONTEND_URL.replace(/\/+$/, '');
    
    // Define shipping options
    const shippingOptions = [
      {
        shipping_rate_data: {
          type: 'fixed_amount',
          fixed_amount: {
            amount: 499,
            currency: 'usd',
          },
          display_name: 'Standard Shipping',
          delivery_estimate: {
            minimum: {
              unit: 'business_day',
              value: 5,
            },
            maximum: {
              unit: 'business_day',
              value: 7,
            },
          },
        },
      },
      {
        shipping_rate_data: {
          type: 'fixed_amount',
          fixed_amount: {
            amount: 999,
            currency: 'usd',
          },
          display_name: 'Express Shipping',
          delivery_estimate: {
            minimum: {
              unit: 'business_day',
              value: 2,
            },
            maximum: {
              unit: 'business_day',
              value: 3,
            },
          },
        },
      },
    ];
    
    // Calculate subtotal
    const subtotal = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    
    // Calculate tax (8.875% for NY)
    const taxRate = 0.08875;
    const taxAmount = Math.round(subtotal * taxRate);
    
    // Create a tax line item
    const taxLineItem = {
      price_data: {
        currency: 'usd',
        product_data: {
          name: 'Sales Tax (8.875%)',
          description: 'NY State and Local Sales Tax',
        },
        unit_amount: taxAmount,
      },
      quantity: 1,
    };
    
    // Add tax to line items
    const allLineItems = [...lineItems, taxLineItem];
    
    const session = await stripe.checkout.sessions.create({
      customer_email: email,
      payment_method_types: ['card'],
      line_items: allLineItems,
      mode: 'payment',
      success_url: `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/cart`,
      metadata: {
        userId,
        orderId,
        taxAmount
      },
      allow_promotion_codes: true,
      billing_address_collection: 'required',
      shipping_address_collection: {
        allowed_countries: ['US']
      },
      shipping_options: shippingOptions,
      // Disable automatic tax since we're calculating it manually
      automatic_tax: {
        enabled: false,
      },
      tax_id_collection: {
        enabled: true,
      }
    });

    res.json({ sessionId: session.id });
  } catch (error) {
    console.error('Error creating checkout session:', error);
    res.status(500).json({ 
      message: error.message || 'An error occurred while creating the checkout session'
    });
  }
});

// Retrieve session details
app.get('/checkout-session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['line_items.data.price.product', 'customer_details', 'payment_intent', 'shipping_cost', 'total_details']
    });

    res.json({
      customer: {
        name: session.customer_details?.name || 'N/A',
        email: session.customer_details?.email || 'N/A'
      },
      items: session.line_items?.data.map(item => ({
        description: item.description,
        quantity: item.quantity,
        amount_total: item.amount_total,
        image_url: item.price.product.metadata.image_url
      })) || [],
      total: session.amount_total,
      shipping: {
        cost: session.shipping_cost?.amount_total || 0,
        name: session.shipping_cost?.shipping_rate?.display_name || 'Standard Shipping'
      },
      tax: {
        amount: session.metadata?.taxAmount || 0
      },
      subtotal: session.total_details?.amount_subtotal || 0
    });
  } catch (error) {
    console.error('Error retrieving session:', error);
    res.status(500).json({ message: 'Failed to retrieve order details' });
  }
});

// Webhook endpoint for handling Stripe events
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    try {
      // Retrieve the session with line items and shipping details
      const expandedSession = await stripe.checkout.sessions.retrieve(session.id, {
        expand: ['line_items.data.price.product', 'shipping_cost', 'total_details', 'customer', 'shipping_details']
      });

      console.log('Expanded session shipping details:', expandedSession.shipping_details);

      // Extract shipping address from session
      const shippingAddress = expandedSession.shipping_details ? {
        name: expandedSession.shipping_details.name,
        address: {
          line1: expandedSession.shipping_details.address.line1,
          line2: expandedSession.shipping_details.address.line2 || null,
          city: expandedSession.shipping_details.address.city,
          state: expandedSession.shipping_details.address.state,
          postal_code: expandedSession.shipping_details.address.postal_code,
          country: expandedSession.shipping_details.address.country,
        },
        phone: expandedSession.shipping_details.phone || null
      } : null;

      // Log shipping address for debugging
      console.log('Extracted shipping address:', JSON.stringify(shippingAddress, null, 2));

      // Prepare order items data
      const orderItems = expandedSession.line_items.data
        .filter(item => item.price.product.metadata.productId) // Filter out tax line item
        .map(item => {
          // Create the order item with required fields
          const orderItem = {
            product_id: item.price.product.metadata.productId,
            quantity: item.quantity,
            price_at_time: item.price.unit_amount
          };
          
          // Only add image_url if it exists in metadata
          if (item.price.product.metadata.image_url) {
            orderItem.image_url = item.price.product.metadata.image_url;
          }
          
          return orderItem;
        });

      // Extract shipping and tax information
      const shippingCost = expandedSession.shipping_cost?.amount_total || 0;
      const shippingName = expandedSession.shipping_cost?.shipping_rate?.display_name || 'Standard Shipping';
      const taxAmount = parseInt(session.metadata.taxAmount) || 0;

      // Insert the order directly instead of using RPC
      const { data: insertedOrder, error: orderError } = await supabase
        .from('orders')
        .insert({
          id: session.metadata.orderId,
          user_id: session.metadata.userId,
          stripe_session_id: session.id,
          status: 'completed',
          total: session.amount_total,
          shipping_address: shippingAddress,
          customer: {
            name: expandedSession.customer?.name || expandedSession.customer_details?.name || 'N/A',
            email: expandedSession.customer?.email || expandedSession.customer_details?.email || 'N/A'
          },
          created_at: new Date(),
          updated_at: new Date()
        })
        .select('id')
        .single();

      if (orderError) {
        console.error('Error inserting order:', orderError);
        return res.status(500).json({ error: 'Failed to insert order' });
      }

      // Insert order items
      const { error: itemsError } = await supabase
        .from('order_items')
        .insert(
          orderItems.map(item => ({
            order_id: session.metadata.orderId,
            ...item
          }))
        );

      if (itemsError) {
        console.error('Error inserting order items:', itemsError);
        // Continue despite the error, as the order is already created
      }

      res.json({ received: true });
    } catch (error) {
      console.error('Error processing webhook:', error);
      res.status(500).json({ error: 'Failed to process webhook' });
    }
  } else {
    res.json({ received: true });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`CORS enabled for origin: ${process.env.FRONTEND_URL.replace(/\/$/, '')}`);
});
